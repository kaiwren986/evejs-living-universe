"use strict";
const protobuf = require("protobufjs");
let root;
function getCareerProtoRoot() {
  return root ||= protobuf.Root.fromJSON(require("./careerProtocol.generated.json").schema).resolveAll();
}
module.exports = { getCareerProtoRoot };
