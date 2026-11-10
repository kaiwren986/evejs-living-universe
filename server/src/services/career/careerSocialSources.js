"use strict";
const database = require("../../gameStore");
function observe(characterID, record, definition, context = {}) {
  if (definition.source?.kind !== "mail-sent") return null;
  if (!context.mail) {
    const result = database.readPersisted("mail", "/");
    if (!result?.success) throw new Error(result?.errorMsg || "CAREER_MAIL_SOURCE_UNAVAILABLE");
    context.mail = result.data || {};
  }
  const receipt = context.mail.careerPlayerMailSent?.[String(characterID)];
  return { kind: "mail-sent", id: "mail-sent:v1", progress: receipt && Number(receipt.messageID) > 0 ? 1 : 0,
    updatedAtMs: Number(receipt?.completedAtMs) || 0 };
}
function supports(source) { return source?.kind === "mail-sent"; }
module.exports = { observe, supports };
