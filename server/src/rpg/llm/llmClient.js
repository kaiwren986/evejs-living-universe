"use strict";

// EveJS RPG fork: the server's one door to the local language model.
//
// Talks to any OpenAI-compatible endpoint (LM Studio by default; see
// config/llm.json). Calls go through one queue so the GPU only ever works on one
// reply at a time, and every call has a timeout. When the model is off, missing
// or slow, chat() resolves to null and the caller uses its written fallback:
// the game never waits on, or breaks because of, the AI.

const fs = require("node:fs");
const path = require("node:path");

const log = require(path.join(__dirname, "../../utils/logger"));

const CONFIG_PATH = path.resolve(__dirname, "../../../../config/llm.json");
const DEFAULTS = Object.freeze({
  enabled: true,
  baseUrl: "http://127.0.0.1:1234/v1",
  identifier: "evejs-npc",
  requestTimeoutMs: 20000,
  reasoningEffort: "none",
});

let queue = Promise.resolve();
let lastFailureLoggedAt = 0;

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function logFailure(message) {
  // The AI being off is normal; say so at most once a minute.
  if (Date.now() - lastFailureLoggedAt > 60000) {
    lastFailureLoggedAt = Date.now();
    log.info(`[LLM] unavailable, using written lines: ${message}`);
  }
}

// Drop reasoning blocks and wrapping quotes some models add around a spoken line.
function clean(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|channel\|>[\s\S]*?<\|message\|>/g, "")
    .trim()
    .replace(/^["“](.*)["”]$/s, "$1")
    .trim();
}

async function request(config, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === "string" ? clean(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the model for a reply.
 * @param {Array<{role: string, content: string}>} messages  system/user/assistant turns
 * @param {{maxTokens?: number, temperature?: number}} options
 * @returns {Promise<string|null>} the reply, or null when the AI is unavailable
 */
function chat(messages, { maxTokens = 220, temperature = 0.8 } = {}) {
  const config = loadConfig();
  if (!config.enabled) return Promise.resolve(null);
  const run = async () => {
    const started = Date.now();
    try {
      const text = await request(config, {
        model: config.identifier,
        messages,
        max_tokens: maxTokens,
        temperature,
        // Spoken lines need no hidden reasoning; models like Gemma 4 otherwise
        // spend the whole token budget thinking and return no text.
        reasoning_effort: config.reasoningEffort,
        stream: false,
      });
      log.info(`[LLM] reply in ${Date.now() - started} ms (${text ? text.length : 0} chars)`);
      return text || null;
    } catch (error) {
      logFailure(error.name === "AbortError" ? `timed out after ${config.requestTimeoutMs} ms` : error.message);
      return null;
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => null);
  return result;
}

module.exports = { chat, loadConfig };
