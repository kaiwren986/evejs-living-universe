"use strict";

const path = require("node:path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  adoptLegacyCertificateFilesOnce,
  certificateDirectory,
} = require(path.join(__dirname, "../../config/certificateFiles"));

const certDir = certificateDirectory();
const certPath = path.join(certDir, "xmpp-dev-cert.pem");
const keyPath = path.join(certDir, "xmpp-dev-key.pem");

function readXmppTlsCredentials() {
  adoptLegacyCertificateFilesOnce((message) => log.info(`[TLS] ${message}`));
  let certificateResult;
  try {
    const { ensureXmppTlsCertificate } = require(path.join(
      __dirname,
      "../../_secondary/express/localTlsCertificate",
    ));
    certificateResult = ensureXmppTlsCertificate({
      outCertPath: certPath,
      outKeyPath: keyPath,
      // The client checks this issuer, not the XMPP hostname. Keep the leaf
      // inside the constrained local CA even when chat is reached over a LAN.
      commonName: "localhost",
    });
    if (certificateResult.rebuilt) {
      log.info(`[XMPP] Generated a TLS certificate at ${certDir} (first run).`);
    }
  } catch (error) {
    throw new Error(
      `XMPP TLS certificate validation/generation failed at ${certDir}: ` +
      `${error.message}`,
    );
  }
  return {
    cert: certificateResult.cert,
    key: certificateResult.key,
  };
}

module.exports = {
  certPath,
  keyPath,
  readXmppTlsCredentials,
};
