"use strict";

// EveJS currently targets one packaged EVE client build and one MachoNet node.
// These values form a compatibility/protocol profile: changing one in isolation
// can invalidate handshakes, object-cache CRCs, or bound-object addresses.
const CLIENT_COMPATIBILITY_PROFILE = Object.freeze({
  clientVersion: 24.01,
  clientBuild: 3_396_210,
  eveBirthday: 170_472,
  machoVersion: 496,
  projectCodename: "EvEJS",
  projectRegion: "ccp",
  projectVersion: "V24.01@ccp",
});

const PROXY_NODE_ID = 0xffaa;
const XMPP_SERVER_PORT = 5222;

// EveJS launch scripts do not use CCP launcher authentication. Keep the
// packaged-client skill-extractor compatibility patch enabled by construction.
const SEED_SKILL_EXTRACTOR_ACCESS_TOKEN = true;

module.exports = {
  CLIENT_COMPATIBILITY_PROFILE,
  PROXY_NODE_ID,
  SEED_SKILL_EXTRACTOR_ACCESS_TOKEN,
  XMPP_SERVER_PORT,
};
