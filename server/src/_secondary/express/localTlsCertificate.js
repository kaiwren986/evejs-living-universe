"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const forge = require("node-forge");

const {
  adoptLegacyCertificateFilesOnce,
  certificateDirectory,
  certificateFilePath,
} = require("../../config/certificateFiles");

// The local CA lives in the data root's certs folder (see config/certificateFiles.js).
const CA_CERT_PATH = certificateFilePath("xmpp-ca-cert.pem");
const CA_KEY_PATH = certificateFilePath("xmpp-ca-key.pem");
// Missing/malformed owner metadata can be a live process paused between the
// atomic path creation and its metadata write. Be deliberately conservative;
// parsed dead-PID locks still bypass this delay and recover immediately.
const GENERATION_LOCK_UNOWNED_STALE_MS = 120_000;
// A waiter must remain alive beyond the conservative unowned threshold, and
// its supervising child must remain alive beyond that complete lock wait.
// Keep these inequalities covered by the focused TLS lifecycle test.
const GENERATION_LOCK_TIMEOUT_MS = 150_000;
const TLS_CERTIFICATE_CHILD_STARTUP_TIMEOUT_MS = 180_000;
const GENERATION_LOCK_POLL_MS = 25;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

const LOCAL_TLS_DNS_ALT_NAMES = Object.freeze([
  "app.launchdarkly.com",
  "clientstream.launchdarkly.com",
  "clientsdk.launchdarkly.com",
  "dev-public-gateway.evetech.net",
  "events.launchdarkly.com",
  "mobile.launchdarkly.com",
  "public-gateway.evetech.net",
  "sdk.launchdarkly.com",
  "sentry.io",
  "stream.launchdarkly.com",
  "localhost",
]);
const LOCAL_TLS_IP_ALT_NAMES = Object.freeze(["127.0.0.1"]);
const RETIRED_CA_SHA1 = "BDAC54736BCC544A2C3DC77294905447FD856FD6";

function localNameConstraintsDer() {
  const asn1 = forge.asn1;
  const sequence = (values) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, values);
  const dnsSubtree = (name) => sequence([
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 2, false, name),
  ]);
  // A DNS constraint permits subdomains too. Excluding each dotted subtree
  // keeps this CA limited to the exact intercepted names.
  const permitted = LOCAL_TLS_DNS_ALT_NAMES.map(dnsSubtree);
  for (const address of LOCAL_TLS_IP_ALT_NAMES) {
    const bytes = address.split(".").map(Number);
    permitted.push(sequence([
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 7, false,
        String.fromCharCode(...bytes, 255, 255, 255, 255)),
    ]));
  }
  return asn1.toDer(sequence([
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, permitted),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 1, true, [
      ...LOCAL_TLS_DNS_ALT_NAMES.map((name) => dnsSubtree(`.${name}`)),
      // SAN-only leaves have no subject name. Exclude every nonempty subject
      // so Windows cannot bypass DNS constraints through CN-only certificates
      // or a second CN appended beneath an allowed directoryName subtree.
      sequence([asn1.create(asn1.Class.CONTEXT_SPECIFIC, 4, true, [sequence([])])]),
    ]),
  ])).getBytes();
}

function hasRequiredNameConstraints(certPem) {
  try {
    const cert = forge.pki.certificateFromPem(String(certPem));
    const constraints = cert.getExtension({ id: "2.5.29.30" });
    const basic = cert.getExtension("basicConstraints");
    return Boolean(constraints && constraints.critical &&
      constraints.value === localNameConstraintsDer() && basic &&
      basic.cA === true && basic.pathLenConstraint === 0 &&
      new crypto.X509Certificate(certPem).fingerprint.replace(/:/g, "") !== RETIRED_CA_SHA1);
  } catch {
    return false;
  }
}

function assertPermittedLeafNames(dnsNames, ipNames) {
  if (dnsNames.some((name) => !LOCAL_TLS_DNS_ALT_NAMES.includes(String(name).toLowerCase())) ||
      ipNames.some((address) => !LOCAL_TLS_IP_ALT_NAMES.includes(address))) {
    throw new Error("Local TLS certificates may cover only intercepted DNS names and 127.0.0.1.");
  }
}

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sleepSync(milliseconds) {
  Atomics.wait(sleepBuffer, 0, 0, Math.max(1, Number(milliseconds) || 1));
}

function processIsAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function readGenerationLock(lockPath) {
  try {
    const metadata = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const stat = fs.statSync(lockPath);
    return {
      ageMs: Math.max(0, Date.now() - stat.mtimeMs),
      pid: Number(metadata && metadata.pid) || 0,
      token: String(metadata && metadata.token || ""),
    };
  } catch {
    try {
      const stat = fs.statSync(lockPath);
      return {
        ageMs: Math.max(0, Date.now() - stat.mtimeMs),
        pid: 0,
        token: "",
      };
    } catch {
      // ignored: the lock file is gone; null means no lock
      return null;
    }
  }
}

function generationLockIsAbandoned(
  lock,
  unownedStaleMs = GENERATION_LOCK_UNOWNED_STALE_MS,
) {
  return Boolean(
    lock &&
    !(
      (lock.pid > 0 && processIsAlive(lock.pid)) ||
      (lock.pid <= 0 && lock.ageMs < unownedStaleMs)
    )
  );
}

function removeAbandonedReclaimGuard(
  guardPath,
  unownedStaleMs = GENERATION_LOCK_UNOWNED_STALE_MS,
) {
  let entries;
  try {
    entries = fs.readdirSync(guardPath, { withFileTypes: true });
  } catch (error) {
    return Boolean(error && error.code === "ENOENT");
  }

  if (entries.length === 0) {
    try {
      const stat = fs.statSync(guardPath);
      if (Date.now() - stat.mtimeMs < unownedStaleMs) {
        return false;
      }
      fs.rmdirSync(guardPath);
      return true;
    } catch (error) {
      return Boolean(error && error.code === "ENOENT");
    }
  }

  const abandonedPaths = [];
  for (const entry of entries) {
    if (!entry.isFile()) return false;
    const ownerPath = path.join(guardPath, entry.name);
    const owner = readGenerationLock(ownerPath);
    if (!generationLockIsAbandoned(owner, unownedStaleMs)) return false;
    abandonedPaths.push(ownerPath);
  }

  // Delete only the exact, uniquely named owner records that were inspected.
  // If another waiter already replaced the directory, its different owner
  // filename keeps rmdir from deleting that successor guard.
  for (const ownerPath of abandonedPaths) {
    try {
      fs.unlinkSync(ownerPath);
    } catch (error) {
      if (!error || error.code !== "ENOENT") return false;
    }
  }
  try {
    fs.rmdirSync(guardPath);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "ENOENT");
  }
}

function acquireReclaimGuard(
  lockPath,
  deadline,
  unownedStaleMs = GENERATION_LOCK_UNOWNED_STALE_MS,
) {
  const guardPath = `${lockPath}.reclaim`;
  const token = `${process.pid}-${crypto.randomBytes(12).toString("hex")}`;
  const ownerPath = path.join(guardPath, `${token}.owner`);

  while (true) {
    try {
      fs.mkdirSync(guardPath);
      let descriptor = null;
      try {
        descriptor = fs.openSync(ownerPath, "wx", 0o600);
        fs.writeFileSync(
          descriptor,
          JSON.stringify({
            createdAt: new Date().toISOString(),
            pid: process.pid,
            token,
          }),
          "utf8",
        );
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = null;
      } catch (error) {
        if (descriptor !== null) {
          try {
            fs.closeSync(descriptor);
          } catch (_) {
            // ignored: cleanup after a failed attempt; the error thrown below is the one that counts
          }
        }
        try {
          fs.unlinkSync(ownerPath);
        } catch (_) {
          // ignored: cleanup after a failed attempt; the error thrown below is the one that counts
        }
        try {
          fs.rmdirSync(guardPath);
        } catch (_) {
          // ignored: cleanup after a failed attempt; the error thrown below is the one that counts
        }
        throw error;
      }

      return () => {
        try {
          fs.unlinkSync(ownerPath);
        } catch (error) {
          if (!error || error.code !== "ENOENT") return false;
        }
        try {
          fs.rmdirSync(guardPath);
          return true;
        } catch (error) {
          return Boolean(error && error.code === "ENOENT");
        }
      };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      removeAbandonedReclaimGuard(guardPath, unownedStaleMs);
      if (Date.now() >= deadline) {
        const timeoutError = new Error(
          `Timed out waiting for TLS certificate reclaim guard ${guardPath}`,
        );
        timeoutError.code = "TLS_CERTIFICATE_LOCK_TIMEOUT";
        throw timeoutError;
      }
      sleepSync(Math.min(GENERATION_LOCK_POLL_MS, deadline - Date.now()));
    }
  }
}

function removeAbandonedGenerationLock(
  lockPath,
  deadline,
  unownedStaleMs = GENERATION_LOCK_UNOWNED_STALE_MS,
) {
  const observed = readGenerationLock(lockPath);
  if (!observed) return true;
  if (!generationLockIsAbandoned(observed, unownedStaleMs)) return false;

  const releaseGuard = acquireReclaimGuard(lockPath, deadline, unownedStaleMs);
  try {
    // The first read is only a hint. Re-read after acquiring the exclusive
    // reclaim guard so no waiter can unlink a newly acquired successor lock
    // based on metadata from the stale predecessor.
    const current = readGenerationLock(lockPath);
    if (!current) return true;
    if (!generationLockIsAbandoned(current, unownedStaleMs)) return false;
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch (error) {
      return Boolean(error && error.code === "ENOENT");
    }
  } finally {
    releaseGuard();
  }
}

function acquireGenerationLock(lockPath, options = {}) {
  ensureParentDirectory(lockPath);
  const timeoutMs = Math.max(
    1,
    Number(options.lockTimeoutMs) || GENERATION_LOCK_TIMEOUT_MS,
  );
  const unownedStaleMs = Math.max(
    1,
    Number(options.unownedStaleMs) || GENERATION_LOCK_UNOWNED_STALE_MS,
  );
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${crypto.randomBytes(12).toString("hex")}`;

  while (true) {
    let descriptor = null;
    let createdLock = false;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      createdLock = true;
      fs.writeFileSync(
        descriptor,
        JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid, token }),
        "utf8",
      );
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      break;
    } catch (error) {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor);
        } catch (_) {
          // ignored: cleanup after a failed attempt; the error below decides whether to retry
        }
      }
      if (createdLock) {
        try {
          fs.unlinkSync(lockPath);
        } catch (_) {
          // ignored: cleanup after a failed attempt; the error below decides whether to retry
        }
      }
      if (!error || error.code !== "EEXIST") {
        throw error;
      }
      if (removeAbandonedGenerationLock(lockPath, deadline, unownedStaleMs)) {
        continue;
      }
      if (Date.now() >= deadline) {
        const timeoutError = new Error(
          `Timed out waiting for TLS certificate generation lock ${lockPath}`,
        );
        timeoutError.code = "TLS_CERTIFICATE_LOCK_TIMEOUT";
        throw timeoutError;
      }
      sleepSync(Math.min(GENERATION_LOCK_POLL_MS, deadline - Date.now()));
    }
  }

  return () => {
    const current = readGenerationLock(lockPath);
    if (!current || current.token !== token) {
      return false;
    }
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch (error) {
      return Boolean(error && error.code === "ENOENT");
    }
  };
}

function writeFileAtomically(filePath, contents, mode = 0o600) {
  ensureParentDirectory(filePath);
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", mode);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (_) {
        // ignored: the write already finished or failed; closing the temporary file is cleanup
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
}

function publishPemPairAtomically(certPath, certPem, keyPath, keyPem) {
  // The certificate is the commit marker. Ensure callers keep the matching
  // generation lock through validation and capture of both published files,
  // then return those captured bytes to consumers.
  writeFileAtomically(keyPath, keyPem, 0o600);
  writeFileAtomically(certPath, certPem, 0o644);
}

function certificateMatchesPrivateKey(certPem, keyPem) {
  try {
    const certificateKey = new crypto.X509Certificate(certPem)
      .publicKey
      .export({ format: "der", type: "spki" });
    const privateKey = crypto.createPublicKey(keyPem)
      .export({ format: "der", type: "spki" });
    return certificateKey.equals(privateKey);
  } catch {
    // ignored: a key that does not parse does not match
    return false;
  }
}

function buildValidatedPairResult(paths, certPem, keyPem, rebuilt) {
  const cert = Buffer.from(certPem, "utf8");
  const key = Buffer.from(keyPem, "utf8");
  return {
    ...paths,
    cert,
    certPem: cert,
    key,
    rebuilt,
  };
}

function certificateAuthorityPemPairIsValid(certPem, keyPem) {
  try {
    const certificate = forge.pki.certificateFromPem(
      Buffer.isBuffer(certPem) ? certPem.toString("utf8") : certPem,
    );
    const now = new Date();
    return hasRequiredNameConstraints(certPem) &&
      certificate.validity.notBefore <= now && certificate.validity.notAfter > now &&
      certificate.verify(certificate) &&
      certificateMatchesPrivateKey(certPem, keyPem);
  } catch {
    // ignored: a certificate that does not parse or verify is not valid
    return false;
  }
}

function randomSerialNumber() {
  const hex = forge.util.bytesToHex(forge.random.getBytesSync(16));
  return hex.replace(/^0+/, "") || "01";
}

function makeValidity(years) {
  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(now.getTime());
  notAfter.setFullYear(notAfter.getFullYear() + years);
  return { notBefore, notAfter };
}

function createCertificateAuthority(options) {
  const keyPair = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  const validity = makeValidity(20);

  cert.publicKey = keyPair.publicKey;
  cert.serialNumber = randomSerialNumber();
  cert.validity.notBefore = validity.notBefore;
  cert.validity.notAfter = validity.notAfter;
  cert.setSubject([
    { name: "organizationName", value: "EvEJS Local" },
    { name: "commonName", value: "EvEJS Local Development CA" },
  ]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
    { id: "2.5.29.30", critical: true, value: localNameConstraintsDer() },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
      digitalSignature: true,
      critical: true,
    },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keyPair.privateKey, forge.md.sha256.create());

  publishPemPairAtomically(
    options.caCertPath,
    forge.pki.certificateToPem(cert),
    options.caKeyPath,
    forge.pki.privateKeyToPem(keyPair.privateKey),
  );
}

function ensureCertificateAuthority(options = {}) {
  const caCertPath = options.caCertPath || CA_CERT_PATH;
  const caKeyPath = options.caKeyPath || CA_KEY_PATH;
  if (caCertPath === CA_CERT_PATH && caKeyPath === CA_KEY_PATH) {
    // Never make a new CA while the old folders still hold the one the client trusts.
    adoptLegacyCertificateFilesOnce();
  }
  const release = acquireGenerationLock(`${caCertPath}.generation.lock`, options);
  try {
    const existingCertPem = fs.existsSync(caCertPath)
      ? fs.readFileSync(caCertPath, "utf8")
      : null;
    const existingKeyPem = fs.existsSync(caKeyPath)
      ? fs.readFileSync(caKeyPath, "utf8")
      : null;
    if (
      existingCertPem &&
      existingKeyPem &&
      certificateAuthorityPemPairIsValid(existingCertPem, existingKeyPem)
    ) {
      return buildValidatedPairResult(
        { caCertPath, caKeyPath },
        existingCertPem,
        existingKeyPem,
        false,
      );
    }

    if ((existingCertPem || existingKeyPem) && !options.rotateCa) {
      const error = new Error(
        "Local CA gate: rotate the old, invalid or unconstrained EveJS CA with " +
        "Install-EvEJSCerts.ps1 -RotateCa before starting the server or client.",
      );
      error.code = "TLS_CA_ROTATION_REQUIRED";
      throw error;
    }
    createCertificateAuthority({ caCertPath, caKeyPath });
    const publishedCertPem = fs.readFileSync(caCertPath, "utf8");
    const publishedKeyPem = fs.readFileSync(caKeyPath, "utf8");
    if (!certificateAuthorityPemPairIsValid(publishedCertPem, publishedKeyPem)) {
      const error = new Error("Published TLS certificate authority pair is invalid");
      error.code = "TLS_CERTIFICATE_PUBLICATION_INVALID";
      throw error;
    }
    return buildValidatedPairResult(
      { caCertPath, caKeyPath },
      publishedCertPem,
      publishedKeyPem,
      true,
    );
  } finally {
    release();
  }
}

function buildSubjectAltNames(options = {}) {
  return [
    ...LOCAL_TLS_DNS_ALT_NAMES.map((value) => ({ type: 2, value })),
    ...(options.dnsOnly === true ? [] : LOCAL_TLS_IP_ALT_NAMES.map((ip) => ({ type: 7, ip }))),
  ];
}

function buildLocalLeafCertificate(options) {
  const caCertPath = options.caCertPath || CA_CERT_PATH;
  const caKeyPath = options.caKeyPath || CA_KEY_PATH;
  const caPair = options.caCert && options.caKey
    ? { cert: options.caCert, key: options.caKey }
    : ensureCertificateAuthority({ ...options, caCertPath, caKeyPath });
  const caCertPem = Buffer.isBuffer(caPair.cert)
    ? caPair.cert.toString("utf8")
    : String(caPair.cert);
  const caKeyPem = Buffer.isBuffer(caPair.key)
    ? caPair.key.toString("utf8")
    : String(caPair.key);
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caPem = caCertPem.trim();
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const keyPair = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  const validity = makeValidity(10);

  cert.publicKey = keyPair.publicKey;
  cert.serialNumber = randomSerialNumber();
  cert.validity.notBefore = validity.notBefore;
  cert.validity.notAfter = validity.notAfter;
  cert.setSubject([]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    {
      name: "basicConstraints",
      cA: false,
      critical: true,
    },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    {
      name: "extKeyUsage",
      serverAuth: true,
      critical: true,
    },
    {
      name: "subjectAltName",
      critical: true,
      altNames: buildSubjectAltNames(options),
    },
    {
      name: "subjectKeyIdentifier",
    },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  publishPemPairAtomically(
    options.outCertPath,
    `${forge.pki.certificateToPem(cert).trim()}\n${caPem}\n`,
    options.outKeyPath,
    forge.pki.privateKeyToPem(keyPair.privateKey),
  );
}

function certificateAttributesEqual(left = [], right = []) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((leftAttribute, index) => {
    const rightAttribute = right[index];
    return (
      rightAttribute &&
      leftAttribute.type === rightAttribute.type &&
      String(leftAttribute.value) === String(rightAttribute.value)
    );
  });
}

function isIssuedByCertificateAuthorityPem(certPem, caCertPem) {
  try {
    const cert = forge.pki.certificateFromPem(
      Buffer.isBuffer(certPem) ? certPem.toString("utf8") : certPem,
    );
    const caCert = forge.pki.certificateFromPem(
      Buffer.isBuffer(caCertPem) ? caCertPem.toString("utf8") : caCertPem,
    );

    return (
      certificateAttributesEqual(
        cert.issuer.attributes,
        caCert.subject.attributes,
      ) &&
      caCert.verify(cert)
    );
  } catch {
    // ignored: a certificate that does not parse or verify was not issued by this CA
    return false;
  }
}

function isIssuedByCertificateAuthority(certPem, caCertPath = CA_CERT_PATH) {
  try {
    return isIssuedByCertificateAuthorityPem(
      certPem,
      fs.readFileSync(caCertPath, "utf8"),
    );
  } catch {
    // ignored: an unreadable CA file means the certificate was not issued by it
    return false;
  }
}

function parseSubjectAltNames(certPem) {
  try {
    const x509 = new crypto.X509Certificate(certPem);
    const dnsNames = new Set();
    const ipAddresses = new Set();

    for (const entry of String(x509.subjectAltName || "").split(",")) {
      const normalized = entry.trim();
      if (normalized.startsWith("DNS:")) {
        dnsNames.add(normalized.slice(4).trim().toLowerCase());
      } else if (normalized.startsWith("IP Address:")) {
        ipAddresses.add(normalized.slice("IP Address:".length).trim());
      }
    }

    return { dnsNames, ipAddresses };
  } catch {
    return {
      dnsNames: new Set(),
      ipAddresses: new Set(),
    };
  }
}

function hasRequiredAltNames(certPem, options = {}) {
  const { dnsNames, ipAddresses } = parseSubjectAltNames(certPem);
  const expectedIpNames = options.dnsOnly === true ? [] : LOCAL_TLS_IP_ALT_NAMES;
  return (
    hasEmptySubjectWithCriticalSan(certPem) &&
    dnsNames.size === LOCAL_TLS_DNS_ALT_NAMES.length &&
    ipAddresses.size === expectedIpNames.length &&
    LOCAL_TLS_DNS_ALT_NAMES.every((name) =>
      dnsNames.has(String(name).toLowerCase()),
    ) &&
    expectedIpNames.every((ip) => ipAddresses.has(ip))
  );
}

function hasEmptySubjectWithCriticalSan(certPem) {
  try {
    const cert = forge.pki.certificateFromPem(String(certPem));
    const san = cert.getExtension("subjectAltName");
    return cert.subject.attributes.length === 0 && Boolean(san && san.critical);
  } catch {
    return false;
  }
}

function ensureLocalLeafCertificate(options = {}) {
  const certDir = options.certDir || certificateDirectory();
  const dnsOnly = options.dnsOnly === true;
  const certificateName = dnsOnly ? "gateway-dns" : "gateway-dev";
  const outCertPath =
    options.outCertPath || path.join(certDir, `${certificateName}-cert.pem`);
  const outKeyPath =
    options.outKeyPath || path.join(certDir, `${certificateName}-key.pem`);
  const caCertPath = options.caCertPath || CA_CERT_PATH;
  const caKeyPath = options.caKeyPath || CA_KEY_PATH;

  const release = acquireGenerationLock(`${outCertPath}.generation.lock`, options);
  try {
    const caPair = ensureCertificateAuthority({
      ...options,
      caCertPath,
      caKeyPath,
    });

    const existingCertPem = fs.existsSync(outCertPath)
      ? fs.readFileSync(outCertPath, "utf8")
      : null;
    const existingKeyPem = fs.existsSync(outKeyPath)
      ? fs.readFileSync(outKeyPath, "utf8")
      : null;

    if (
      existingCertPem &&
      existingKeyPem &&
      hasRequiredAltNames(existingCertPem, { dnsOnly }) &&
      isIssuedByCertificateAuthorityPem(existingCertPem, caPair.cert) &&
      certificateMatchesPrivateKey(existingCertPem, existingKeyPem)
    ) {
      return buildValidatedPairResult(
        { outCertPath, outKeyPath },
        existingCertPem,
        existingKeyPem,
        false,
      );
    }

    buildLocalLeafCertificate({
      caCert: caPair.cert,
      caCertPath,
      caKey: caPair.key,
      caKeyPath,
      dnsOnly,
      outCertPath,
      outKeyPath,
    });
    const publishedCertPem = fs.readFileSync(outCertPath, "utf8");
    const publishedKeyPem = fs.readFileSync(outKeyPath, "utf8");
    if (
      !hasRequiredAltNames(publishedCertPem, { dnsOnly }) ||
      !isIssuedByCertificateAuthorityPem(publishedCertPem, caPair.cert) ||
      !certificateMatchesPrivateKey(publishedCertPem, publishedKeyPem)
    ) {
      const error = new Error("Published public-gateway TLS certificate pair is invalid");
      error.code = "TLS_CERTIFICATE_PUBLICATION_INVALID";
      throw error;
    }

    return buildValidatedPairResult(
      { outCertPath, outKeyPath },
      publishedCertPem,
      publishedKeyPem,
      true,
    );
  } finally {
    release();
  }
}

// Ensure a CA-signed TLS cert for the XMPP chat server exists at the given
// paths, creating the shared CA if needed. The EVE client validates the chat
// TLS connection against its certifi CA bundle only and does NOT check the
// hostname, so the SAN set is not critical (localhost + 127.0.0.1 by default,
// plus any extraHosts). Lets a fresh checkout start instead of throwing.
function ensureXmppTlsCertificate(options = {}) {
  const outCertPath = options.outCertPath;
  const outKeyPath = options.outKeyPath;
  if (!outCertPath || !outKeyPath) {
    throw new Error("ensureXmppTlsCertificate requires outCertPath and outKeyPath.");
  }
  const caCertPath = options.caCertPath || CA_CERT_PATH;
  const caKeyPath = options.caKeyPath || CA_KEY_PATH;

  const release = acquireGenerationLock(`${outCertPath}.generation.lock`, options);
  try {
    const caPair = ensureCertificateAuthority({
      ...options,
      caCertPath,
      caKeyPath,
    });

    const existingCertPem = fs.existsSync(outCertPath)
      ? fs.readFileSync(outCertPath, "utf8")
      : null;
    const existingKeyPem = fs.existsSync(outKeyPath)
      ? fs.readFileSync(outKeyPath, "utf8")
      : null;
    if (
      existingCertPem &&
      existingKeyPem &&
      hasEmptySubjectWithCriticalSan(existingCertPem) &&
      isIssuedByCertificateAuthorityPem(existingCertPem, caPair.cert) &&
      certificateMatchesPrivateKey(existingCertPem, existingKeyPem)
    ) {
      return buildValidatedPairResult(
        { outCertPath, outKeyPath },
        existingCertPem,
        existingKeyPem,
        false,
      );
    }

    const commonName = String(options.commonName || "localhost").trim() || "localhost";
    const dnsAltNames = [];
    const ipAltNames = [];
    const pushHost = (host) => {
      const value = String(host || "").trim();
      if (!value) {
        return;
      }
      if (net.isIP(value)) {
        if (!ipAltNames.includes(value)) {
          ipAltNames.push(value);
        }
      } else if (!dnsAltNames.includes(value)) {
        dnsAltNames.push(value);
      }
    };
    [commonName, "localhost", "127.0.0.1", ...(options.extraHosts || [])]
      .forEach(pushHost);
    assertPermittedLeafNames(dnsAltNames, ipAltNames);

    const caCertPem = caPair.cert.toString("utf8");
    const caKeyPem = caPair.key.toString("utf8");
    const caCert = forge.pki.certificateFromPem(caCertPem);
    const caPem = caCertPem.trim();
    const caKey = forge.pki.privateKeyFromPem(caKeyPem);
    const keyPair = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    const validity = makeValidity(10);

    cert.publicKey = keyPair.publicKey;
    cert.serialNumber = randomSerialNumber();
    cert.validity.notBefore = validity.notBefore;
    cert.validity.notAfter = validity.notAfter;
    cert.setSubject([]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false, critical: true },
      {
        name: "keyUsage",
        digitalSignature: true,
        keyEncipherment: true,
        critical: true,
      },
      { name: "extKeyUsage", serverAuth: true, critical: true },
      {
        name: "subjectAltName",
        critical: true,
        altNames: [
          ...dnsAltNames.map((value) => ({ type: 2, value })),
          ...ipAltNames.map((ip) => ({ type: 7, ip })),
        ],
      },
      { name: "subjectKeyIdentifier" },
    ]);
    cert.sign(caKey, forge.md.sha256.create());

    publishPemPairAtomically(
      outCertPath,
      `${forge.pki.certificateToPem(cert).trim()}\n${caPem}\n`,
      outKeyPath,
      forge.pki.privateKeyToPem(keyPair.privateKey),
    );
    const publishedCertPem = fs.readFileSync(outCertPath, "utf8");
    const publishedKeyPem = fs.readFileSync(outKeyPath, "utf8");
    if (
      !hasEmptySubjectWithCriticalSan(publishedCertPem) ||
      !isIssuedByCertificateAuthorityPem(publishedCertPem, caPair.cert) ||
      !certificateMatchesPrivateKey(publishedCertPem, publishedKeyPem)
    ) {
      const error = new Error("Published XMPP TLS certificate pair is invalid");
      error.code = "TLS_CERTIFICATE_PUBLICATION_INVALID";
      throw error;
    }

    return buildValidatedPairResult(
      { outCertPath, outKeyPath },
      publishedCertPem,
      publishedKeyPem,
      true,
    );
  } finally {
    release();
  }
}

module.exports = {
  CA_CERT_PATH,
  CA_KEY_PATH,
  GENERATION_LOCK_TIMEOUT_MS,
  GENERATION_LOCK_UNOWNED_STALE_MS,
  LOCAL_TLS_DNS_ALT_NAMES,
  LOCAL_TLS_IP_ALT_NAMES,
  RETIRED_CA_SHA1,
  TLS_CERTIFICATE_CHILD_STARTUP_TIMEOUT_MS,
  buildLocalLeafCertificate,
  certificateMatchesPrivateKey,
  certificateAuthorityPemPairIsValid,
  ensureCertificateAuthority,
  ensureLocalLeafCertificate,
  ensureXmppTlsCertificate,
  hasRequiredAltNames,
  hasRequiredNameConstraints,
  hasEmptySubjectWithCriticalSan,
  assertPermittedLeafNames,
  isIssuedByCertificateAuthority,
};
