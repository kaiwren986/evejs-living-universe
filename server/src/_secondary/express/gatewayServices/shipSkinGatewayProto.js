"use strict";

const protobuf = require("protobufjs");
const { schema } = require("./shipSkinProtocol.generated.json");
let root;
function getShipSkinProtoRoot() {
  return root ||= protobuf.Root.fromJSON(schema).resolveAll();
}
module.exports = { getShipSkinProtoRoot };
