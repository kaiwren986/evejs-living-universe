"use strict";
const protobuf = require("protobufjs");
const crypto = require("node:crypto");
const lifecycle = require("../../../services/newEdenStore/licenseLifecycle");
const runtime = require("../../../services/newEdenStore/licenseLifecycleRuntime");
const PREFIX = "eve_public.user.license.api.";
// Field numbers and expiry oneof match build3396210's retained Python protobuf
// descriptors. The supported client recognizes only eve_clonestate_omega.
const root = protobuf.parse(`syntax = "proto3";
package eve_public.user.license.api;
message Timestamp { int64 seconds = 1; int32 nanos = 2; }
message Identifier { string license_type = 1; }
message Attributes { oneof has_expiry_date { bool no_expiry_date = 1; Timestamp expiry_date = 2; } Timestamp last_modified = 3; }
message CreatedNotice { Identifier identifier = 1; Attributes license = 2; }
message ActivatedNotice { Identifier identifier = 1; Attributes license = 2; }
message ExpiryDateExtendedNotice { Identifier identifier = 1; Attributes license = 2; }
message ExpiryDateReducedNotice { Identifier identifier = 1; Attributes license = 2; }
message ExpiredNotice { Identifier identifier = 1; Attributes license = 2; }
`).root;
function attributes(license) {
  return { expiry_date: lifecycle.timestamp(license.expiryFileTime),
    last_modified: lifecycle.timestamp(license.lastModifiedFileTime) };
}
function createUserLicenseGatewayService(context) {
  const dispose = typeof context?.publishGatewayNotice === "function" ? runtime.subscribe(event => {
    const typeName = PREFIX + event.kind;
    const type = root.lookupType(typeName);
    const payload = Buffer.from(type.encode(type.create({ identifier: { license_type: event.licenseType }, license: attributes(event) })).finish());
    const noticeUUID = crypto.createHash("sha256").update(`evejs-license:${event.accountID}:${event.revision}`).digest().subarray(0, 16);
    return context.publishGatewayNotice(typeName, payload, { user: event.accountID }, { noticeUUID });
  }) : () => {};
  return { name: "user-license-notices", handledRequestTypes: [], handleRequest: () => null, dispose };
}
module.exports = { createUserLicenseGatewayService, attributes, root };
