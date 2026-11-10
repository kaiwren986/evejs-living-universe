"use strict";

const fs = require("fs");
const path = require("path");
const {
  assertPermittedLeafNames,
  certificateAuthorityPemPairIsValid,
  certificateMatchesPrivateKey,
  ensureCertificateAuthority,
  hasEmptySubjectWithCriticalSan,
  isIssuedByCertificateAuthority,
} = require("../../../server/src/_secondary/express/localTlsCertificate");
// node-forge ships in the root package.json so certificate generation works on a
// fresh checkout that has not installed the server packages yet. The plain
// require walks up to <repo>/node_modules; the server tree is a fallback for an
// install that only ran `npm --prefix server ci`.
let forge;
try {
  forge = require("node-forge");
} catch {
  try {
    forge = require(path.join(
      __dirname,
      "..",
      "..",
      "..",
      "server",
      "node_modules",
      "node-forge",
    ));
  } catch {
    throw new Error(
      "node-forge is not installed. Run 'npm ci' in the project root " +
        "(or SetupEveJS.bat) and try again.",
    );
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      args[key] = true;
      continue;
    }

    if (args[key] === undefined) {
      args[key] = value;
    } else if (Array.isArray(args[key])) {
      args[key].push(value);
    } else {
      args[key] = [args[key], value];
    }
    index += 1;
  }

  return args;
}

function ensureFileExists(filePath, label) {
  if (!filePath) {
    throw new Error(`Missing required argument: ${label}`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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

function getListArg(args, key, fallback) {
  const value = args[key];
  if (value === undefined || value === true) {
    return fallback;
  }
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readOrCreateCertificateAuthority(options) {
  if (options.ensureCa) {
    ensureCertificateAuthority({
      caCertPath: options.caCert,
      caKeyPath: options.caKey,
      rotateCa: options.rotateCa,
    });
  }

  ensureFileExists(options.caCert, "--ca-cert");
  ensureFileExists(options.caKey, "--ca-key");
  if (!certificateAuthorityPemPairIsValid(fs.readFileSync(options.caCert), fs.readFileSync(options.caKey))) {
    throw new Error("Local CA gate: the CA is expired, unconstrained or has the wrong key. Run Install-EvEJSCerts.ps1 -RotateCa.");
  }

  return {
    cert: forge.pki.certificateFromPem(fs.readFileSync(options.caCert, "utf8")),
    key: forge.pki.privateKeyFromPem(fs.readFileSync(options.caKey, "utf8")),
    pem: fs.readFileSync(options.caCert, "utf8").trim(),
  };
}

function buildGatewayCertificate(options) {
  assertPermittedLeafNames(options.dnsNames, options.ipNames);
  const ca = readOrCreateCertificateAuthority(options);
  const keyPair = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  const validity = makeValidity(10);

  cert.publicKey = keyPair.publicKey;
  cert.serialNumber = randomSerialNumber();
  cert.validity.notBefore = validity.notBefore;
  cert.validity.notAfter = validity.notAfter;
  cert.setSubject([]);
  cert.setIssuer(ca.cert.subject.attributes);
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
      altNames: [
        ...options.dnsNames.map((value) => ({ type: 2, value })),
        ...options.ipNames.map((ip) => ({ type: 7, ip })),
      ],
    },
    {
      name: "subjectKeyIdentifier",
    },
  ]);

  cert.sign(ca.key, forge.md.sha256.create());

  ensureParentDirectory(options.outCert);
  ensureParentDirectory(options.outKey);
  fs.writeFileSync(
    options.outCert,
    `${forge.pki.certificateToPem(cert).trim()}\n${ca.pem}\n`,
    "utf8",
  );
  fs.writeFileSync(options.outKey, forge.pki.privateKeyToPem(keyPair.privateKey), "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dnsOnly = args["dns-only"] === true;
  if (args["dns-only"] !== undefined && !dnsOnly) {
    throw new Error("--dns-only is a flag and does not accept a value.");
  }
  if (dnsOnly && args.ip !== undefined) {
    throw new Error("--dns-only cannot be combined with --ip.");
  }
  if (!args["ca-cert"]) {
    throw new Error("Missing required argument: --ca-cert");
  }
  if (!args["ca-key"]) {
    throw new Error("Missing required argument: --ca-key");
  }

  if (args["ca-only"]) {
    readOrCreateCertificateAuthority({
      caCert: args["ca-cert"], caKey: args["ca-key"],
      ensureCa: Boolean(args["ensure-ca"]) && !args["check-only"],
      rotateCa: Boolean(args["rotate-ca"]),
    });
    return;
  }

  if (!args["out-cert"]) {
    throw new Error("Missing required argument: --out-cert");
  }
  if (!args["out-key"]) {
    throw new Error("Missing required argument: --out-key");
  }

  if (args["check-only"]) {
    readOrCreateCertificateAuthority({ caCert: args["ca-cert"], caKey: args["ca-key"] });
    const cert = fs.readFileSync(args["out-cert"]);
    const key = fs.readFileSync(args["out-key"]);
    const x509 = new (require("crypto").X509Certificate)(cert);
    const altNames = forge.pki.certificateFromPem(cert.toString()).getExtension("subjectAltName");
    const dnsNames = (altNames?.altNames || []).filter((name) => name.type === 2).map((name) => name.value);
    const ipNames = (altNames?.altNames || []).filter((name) => name.type === 7).map((name) => name.ip);
    assertPermittedLeafNames(dnsNames, ipNames);
    const expectedDns = getListArg(args, "dns", []);
    const expectedIps = dnsOnly ? [] : getListArg(args, "ip", []);
    if (!hasEmptySubjectWithCriticalSan(cert) || !certificateMatchesPrivateKey(cert, key) || !isIssuedByCertificateAuthority(cert, args["ca-cert"]) ||
        Date.parse(x509.validFrom) > Date.now() || Date.parse(x509.validTo) <= Date.now() ||
        expectedDns.some((name) => !dnsNames.includes(name)) ||
        (args.dns !== undefined && expectedDns.length !== dnsNames.length) ||
        expectedIps.some((name) => !ipNames.includes(name)) ||
        ((dnsOnly || args.ip !== undefined) && expectedIps.length !== ipNames.length)) {
      throw new Error("Local TLS gate: missing, expired or stale leaf certificate. Run Install-EvEJSCerts.ps1 -RotateCa.");
    }
    return;
  }

  buildGatewayCertificate({
    caCert: args["ca-cert"],
    caKey: args["ca-key"],
    outCert: args["out-cert"],
    outKey: args["out-key"],
    ensureCa: args["ensure-ca"] === true || args["ensure-ca"] === "true",
    rotateCa: Boolean(args["rotate-ca"]),
    commonName: args["common-name"] || "dev-public-gateway.evetech.net",
    dnsNames: getListArg(args, "dns", [
      "dev-public-gateway.evetech.net",
      "public-gateway.evetech.net",
      "localhost",
    ]),
    ipNames: dnsOnly ? [] : getListArg(args, "ip", ["127.0.0.1"]),
  });
}

main();
