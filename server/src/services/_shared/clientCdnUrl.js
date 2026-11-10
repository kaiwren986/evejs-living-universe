"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../config"));

// The client fetches a CDN checkpoint's url with HTTPSConnection(host,
// port=443), taking host as everything between "//" and the next "/". A port
// in the url stays glued to the host and fails getaddrinfo, so the url names
// the host alone, over https: the loopback CDN responder answers on 443.
function buildClientCdnUrl(routePath, publicBaseUrl = config.microservicesPublicUrl) {
  const url = new URL(routePath, String(publicBaseUrl));
  url.protocol = "https:";
  url.port = "";
  return url.toString();
}

module.exports = {
  buildClientCdnUrl,
};
