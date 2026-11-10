"use strict";

function collapseWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isClientSafeAscii(value) {
  return /^[\x20-\x7E]+$/.test(String(value || ""));
}

function toClientSafeText(value) {
  const text = String(value ?? "");
  return isClientSafeAscii(text) ? text : { type: "wstring", value: text };
}

function toClientSafeDisplayName(value, fallback = "Item") {
  const name = collapseWhitespace(value) || collapseWhitespace(fallback) || "Item";
  return toClientSafeText(name);
}

module.exports = {
  collapseWhitespace,
  isClientSafeAscii,
  toClientSafeText,
  toClientSafeDisplayName,
};
