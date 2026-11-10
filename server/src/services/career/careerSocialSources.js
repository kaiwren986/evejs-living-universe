"use strict";
const { readDurablePath } = require("./careerOwnerReads");
function observe(characterID, record, definition, context = {}) {
  if (definition.source?.kind !== "mail-sent") return null;
  const receipt = readDurablePath("mail", `/careerPlayerMailSent/${characterID}`, context,
    "CAREER_MAIL_SOURCE_UNAVAILABLE");
  return { kind: "mail-sent", id: "mail-sent:v1", progress: receipt && Number(receipt.messageID) > 0 ? 1 : 0,
    updatedAtMs: Number(receipt?.completedAtMs) || 0 };
}
function supports(source) { return source?.kind === "mail-sent"; }
module.exports = { observe, supports };
