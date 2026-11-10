"use strict";

const SkillMgrService = require("./skillMgrService");

// TQ's skill handler lives on skillMgr2 itself: GetMySkillHandler answers a
// moniker on skillMgr2 bound to the character, and the client binds it with
// skillMgr2.MachoBindObject(charID, (method, args, kwargs)) and calls every
// skill method on the bound object (golden log "Logging In To Space":
// "Generic moniker on service skillMgr2 ... params 2124510715", then
// skillMgr2::MachoBindObject args=(2124510715, ('GetBoosters', (), {}))).
// So this service carries the skill handler's methods, as skillHandler does.
class SkillMgr2Service extends SkillMgrService {
  constructor() {
    super();
    this._name = "skillMgr2";
  }

  Handle_GetMySkillHandler(args, session) {
    return {
      type: "object",
      name: "carbon.common.script.net.moniker.Moniker",
      args: [
        "skillMgr2", // [0] __serviceName
        null, // [1] __nodeID
        session && (session.characterID || session.charid || session.userid), // [2] __bindParams
        null, // [3] __sessionCheck
      ],
    };
  }
}

module.exports = SkillMgr2Service;
