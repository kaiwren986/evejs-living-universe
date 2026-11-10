"use strict";

// CERTIFICATE FILES
//
// Where the server keeps its TLS certificates and private keys: the certs area of the data root
// (see dataRoot.js), so <repo>/_local/certs on a native install and /var/lib/evejs/certs in
// Docker. That holds the local CA (xmpp-ca-cert.pem, xmpp-ca-key.pem), the chat server's
// certificate (xmpp-dev-*.pem) and the public gateway's certificates (gateway-*.pem and the rest).
//
// Until 2026-09-21 they lived in the checkout: the CA and the chat certificate in server/certs,
// the gateway certificates in server/src/_secondary/express/certs. adoptLegacyCertificateFiles
// copies any file from those two folders that the certs area does not have yet, so an install
// that already has a CA keeps it: the client trusts that CA, and making a new one would mean every
// player setting up certificates again. It copies rather than moves, so nothing is lost if the
// data root points somewhere temporary, such as a test's scratch folder; the old files are left
// where they were and nothing reads them again. This module requires only fs, path and
// dataRoot.js, so the setup scripts can use it without loading the server.

const fs = require("fs");
const path = require("path");

const { REPO_ROOT, resolveDataRootPath } = require("./dataRoot");

const LEGACY_CERTIFICATE_DIRS = Object.freeze([
  path.join(REPO_ROOT, "server", "certs"),
  path.join(REPO_ROOT, "server", "src", "_secondary", "express", "certs"),
]);

// The same file kinds the updater keeps for these folders (tools/Updater/update-policy.json).
const CERTIFICATE_FILE_PATTERN = /(\.pem|\.pfx|\.key|passphrase.*\.txt)$/i;

function certificateDirectory() {
  return resolveDataRootPath("certs");
}

function certificateFilePath(fileName) {
  return path.join(certificateDirectory(), fileName);
}

function copyFileKeepingMode(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  // COPYFILE_EXCL: never overwrite a file that appeared in the meantime.
  fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(targetPath, fs.statSync(sourcePath).mode & 0o777);
  } catch {
    // Keeping the mode is best effort; Windows ignores most of it anyway.
  }
}

// Copies certificate files from the old folders into the certs area when the certs area does not
// have them. Returns what it did, so the caller can log it: copied lists each file copied,
// skipped lists each old file left alone because the certs area already has a file of that name.
function adoptLegacyCertificateFiles(options = {}) {
  const targetDir = options.targetDir || certificateDirectory();
  const legacyDirs = options.legacyDirs || LEGACY_CERTIFICATE_DIRS;
  const copied = [];
  const skipped = [];
  for (const legacyDir of legacyDirs) {
    let names;
    try {
      names = fs.readdirSync(legacyDir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!CERTIFICATE_FILE_PATTERN.test(name)) {
        continue;
      }
      const sourcePath = path.join(legacyDir, name);
      if (path.resolve(sourcePath) === path.resolve(path.join(targetDir, name))) {
        continue;
      }
      let isFile = false;
      try {
        isFile = fs.statSync(sourcePath).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) {
        continue;
      }
      const targetPath = path.join(targetDir, name);
      if (fs.existsSync(targetPath)) {
        skipped.push({ from: sourcePath, to: targetPath });
        continue;
      }
      try {
        copyFileKeepingMode(sourcePath, targetPath);
        copied.push({ from: sourcePath, to: targetPath });
      } catch (error) {
        if (error && error.code === "EEXIST") {
          skipped.push({ from: sourcePath, to: targetPath });
          continue;
        }
        throw error;
      }
    }
  }
  return { targetDir, copied, skipped };
}

let adoptedThisProcess = null;

// adoptLegacyCertificateFiles for the default folders, once per process: the certificate code
// calls this every time it is about to read or make a default certificate, and only the first
// call touches the disk. The result of that first call is returned each time. logInfo, when
// given, receives a one-line summary, and only from the call that actually copied something.
function adoptLegacyCertificateFilesOnce(logInfo) {
  if (adoptedThisProcess) {
    return adoptedThisProcess;
  }
  adoptedThisProcess = adoptLegacyCertificateFiles();
  const summary = describeAdoption(adoptedThisProcess);
  if (summary && typeof logInfo === "function") {
    logInfo(summary);
  }
  return adoptedThisProcess;
}

// A one-line summary for the log, or "" when nothing was copied.
function describeAdoption(result) {
  if (!result || !result.copied || result.copied.length === 0) {
    return "";
  }
  const names = result.copied.map((entry) => path.basename(entry.to)).join(", ");
  return `Copied ${result.copied.length} certificate file(s) from the old folders into ${result.targetDir}: ${names}.`;
}

module.exports = {
  CERTIFICATE_FILE_PATTERN,
  LEGACY_CERTIFICATE_DIRS,
  adoptLegacyCertificateFiles,
  adoptLegacyCertificateFilesOnce,
  certificateDirectory,
  certificateFilePath,
  describeAdoption,
};

// Setup scripts run this file directly: it copies the old files if needed and prints JSON with
// the certs folder, so they use the same folder and the same rule as the server.
if (require.main === module) {
  const result = adoptLegacyCertificateFiles();
  process.stdout.write(`${JSON.stringify({
    certDir: result.targetDir,
    copied: result.copied.map((entry) => entry.to),
    skipped: result.skipped.map((entry) => entry.from),
  })}\n`);
}
