"use strict";
const protobuf = require("protobufjs");
const { TextDecoder } = require("node:util");
const { bufferFromBytes, getActiveCharacterID, encodePayload } = require("./gatewayServiceHelpers");
const characters = require("../../../services/character/characterState");
const accounts = require("../../../services/login/accountStore");
const REQUEST = "eve_public.ai.assistant.chat.api.QueryRequest";
const RESPONSE = "eve_public.ai.assistant.chat.api.QueryResponse";
const MAX_PAYLOAD_BYTES = 4096, MAX_MESSAGE_BYTES = 2048;
const LABEL = "Local Aura guidance: ";
const root = new protobuf.Root();
// Retained build3396210 descriptors and the Cerberus consumer establish these
// wire contracts. No client feature code or localization corpus is copied.
for (const schema of [
  `syntax="proto3"; package google.protobuf;
   message Timestamp { int64 seconds=1; int32 nanos=2; }
   message Duration { int64 seconds=1; int32 nanos=2; }`,
  `syntax="proto3"; package eve_public.localization.cerberus;
   message Parameter { string key=1; oneof value { string string=2; uint64 integer=3;
     int64 signed_integer=4; double double=5; google.protobuf.Timestamp timestamp=6;
     google.protobuf.Duration duration=7; } }
   message DynamicFormattedMessage { string text=1; repeated Parameter parameters=2; }`,
  `syntax="proto3"; package eve_public.ai.assistant.chat.api;
   message QueryRequest { string message=1; }
   message QueryResponse { string response=1; bool fallback=2;
     eve_public.localization.cerberus.DynamicFormattedMessage formatted_response=3; }`,
]) protobuf.parse(schema, root, { keepCase: true });
root.resolveAll();
const requestType = root.lookupType(REQUEST), responseType = root.lookupType(RESPONSE);
const TOPICS = Object.freeze([
  { words: ["air", "tutorial", "aura", "operations"], text: "Open Operations and follow your current AIR objective. Finish Aura's instructions in the introductory sequence before leaving its site." },
  { words: ["dock", "docking", "station"], text: "Select a station and choose Dock. Your ship must approach within docking range. You can fit modules and manage your hangar while docked." },
  { words: ["warp", "warping", "travel", "movement", "move", "jump", "stargate"], text: "Select a destination in the overview or space and choose Warp To. Undock first when in a station. Use stargates to travel between solar systems." },
  { words: ["fit", "fitting", "module", "modules", "cpu", "powergrid"], text: "Dock and open Fitting. Check the ship's slots, CPU, powergrid and skill requirements. Online your modules and load compatible charges when a module requires them." },
  { words: ["mine", "mining", "asteroid", "asteroids", "ore"], text: "Fit a mining laser, travel to an asteroid belt, approach an asteroid and lock it. Activate the laser within range and keep space available in your ore hold or cargo." },
  { words: ["combat", "shoot", "shooting", "weapon", "weapons", "lock", "locking"], text: "Lock a hostile target and check your weapon's range. Make sure the weapon is online, load compatible charges if it requires them, and activate it on the target." },
  { words: ["scan", "scanning", "probe", "probes", "exploration", "hacking"], text: "Fit a probe launcher with probes and use the Probe Scanner to locate signatures. Warp to a resolved site. Data and relic analyzers operate on compatible site containers." },
  { words: ["skill", "skills", "training", "queue"], text: "Open the skill catalogue to learn an available skill, then add its next level to your training queue. Skill prerequisites, Alpha restrictions and account training slots still apply." },
]);
function responseText(query) {
  const tokens = new Set(String(query || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);
  const topic = TOPICS.find(row => row.words.some(word => tokens.has(word)));
  return LABEL + (topic?.text || "Ask about the AIR tutorial, travel, docking, fitting, mining, combat, scanning or skill training. These are authored local help replies; no AI service or live player-state analysis is used.");
}
function authenticatedCharacter(envelope) {
  const id = getActiveCharacterID(envelope), context = envelope?.authoritative_context;
  if (!Number.isSafeInteger(id) || id <= 0 || context?.no_active_identity === true || context?.no_authenticated_user === true) return false;
  const active = Number(context?.active_character?.sequential || 0);
  if (active && active !== id) return false;
  const character = characters.peekCharacterRecord(id);
  const accountID = Number(character?.accountID ?? character?.accountId);
  if (!character || character.deletedAt || character.isDeleted || !Number.isSafeInteger(accountID) || accountID <= 0) return false;
  if (!context?.authenticated_user || Number(context.authenticated_user.sequential) !== accountID) return false;
  return Object.values(accounts.readAccountsTable()).some(account => Number(account?.accountID ?? account?.id ?? account?.userID) === accountID && !account.banned);
}
function decodeQuery(bytes) {
  const decoded = requestType.decode(bytes), reader = protobuf.Reader.create(bytes);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (!(tag >>> 3)) throw new Error("INVALID_PROTOBUF_TAG");
    if ((tag >>> 3) === 1) {
      if ((tag & 7) !== 2) throw new Error("INVALID_MESSAGE_WIRE_TYPE");
      utf8.decode(reader.bytes());
    } else reader.skipType(tag & 7);
  }
  return decoded.message || "";
}
function createAuraGuidanceGatewayService() {
  return { name: "aura-guidance", handledRequestTypes: [REQUEST],
    handleRequest(type, envelope) {
      if (type !== REQUEST) return null;
      const respond = (statusCode, text) => ({ statusCode, statusMessage: "", responseTypeName: RESPONSE,
        responsePayloadBuffer: encodePayload(responseType, { response: text, fallback: true,
          formatted_response: { text, parameters: [] } }) });
      if (!authenticatedCharacter(envelope)) return respond(401, LABEL + "Select an authenticated character to use local help.");
      const bytes = bufferFromBytes(envelope?.payload?.value);
      if (bytes.length > MAX_PAYLOAD_BYTES) return respond(413, LABEL + "Please ask a shorter question.");
      let query;
      try { query = decodeQuery(bytes); }
      catch (_) { return respond(400, LABEL + "The help request could not be decoded."); }
      if (Buffer.byteLength(query, "utf8") > MAX_MESSAGE_BYTES) return respond(413, LABEL + "Please ask a shorter question.");
      return respond(200, responseText(query));
    },
  };
}
module.exports = { createAuraGuidanceGatewayService, responseText, root, REQUEST, RESPONSE, MAX_PAYLOAD_BYTES, MAX_MESSAGE_BYTES };
