"use strict";

// Client wire contract: ClientCodeGrabber/Latest/bugreporter/__init__.py.
// There is no finish-upload call; every acknowledged upload must leave a ZIP
// ready to use. Keep the initial server-log snapshot as attachments arrive.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { collectReport, verifyZip, writeZip } = require("./collect-error-report");

const PORT = 26004;
const MAX_ATTACHMENT = 32 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL = 128 * 1024 * 1024;
const categories = ["Gameplay", "User Interface", "Graphics", "Audio", "Other"]
  .map((value, index) => ({ id: String(index + 1), value }));

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail(413, "Upload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseAttachment(contentType, body) {
  const match = /^multipart\/form-data;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))$/i.exec(contentType || "");
  const boundary = match && (match[1] || match[2]);
  if (!boundary || boundary.length > 200) throw fail(400, "Invalid multipart boundary");
  const start = Buffer.from(`--${boundary}\r\n`);
  const end = Buffer.from(`\r\n--${boundary}--\r\n`);
  const split = body.indexOf("\r\n\r\n");
  if (!body.subarray(0, start.length).equals(start) || split < start.length || split > 8192 ||
      !body.subarray(-end.length).equals(end)) throw fail(400, "Malformed attachment");
  const headers = body.toString("utf8", start.length, split);
  const disposition = /^Content-Disposition: form-data; name="File"; filename="([^"\r\n]+)"$/im.exec(headers);
  const name = disposition && disposition[1];
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,119}$/.test(name) || name.includes("..") ||
      /\.(pem|pfx|p12|key|sqlite[^.]*)$|passphrase|\.env/i.test(name)) {
    throw fail(400, "Invalid attachment filename");
  }
  const data = body.subarray(split + 4, body.length - end.length);
  if (data.includes(Buffer.from(`\r\n--${boundary}\r\n`))) throw fail(400, "Expected one file");
  if (data.length > MAX_ATTACHMENT) throw fail(413, "Attachment too large");
  return { name, data };
}

function createBugReportService(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, "../.."));
  const outDir = path.resolve(options.outDir || path.join(root, "_local", "error-reports"));
  const server = http.createServer(async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(data));
    };
    try {
      // Reject browser-driven submissions and DNS-rebinding hostnames. The
      // native Python client sends neither Origin nor Sec-Fetch-Site.
      if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.origin ||
          req.headers["sec-fetch-site"] ||
          !/^127\.0\.0\.1:\d+$/.test(req.headers.host || "")) throw fail(403, "Local client only");
      if (req.method === "GET" && req.url === "/api/status") return reply(200, { isOnline: true });
      if (req.method === "GET" && req.url === "/api/category") return reply(200, { categories });
      if (req.method === "POST" && req.url === "/api/issue") {
        if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) throw fail(415, "Expected JSON");
        let report;
        try { report = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8")); }
        catch (error) { throw error.status ? error : fail(400, "Invalid JSON"); }
        if (!report || Array.isArray(report) || ["summary", "description", "reproductionSteps", "categoryID"]
          .some((key) => typeof report[key] !== "string" || !report[key].trim())) throw fail(400, "Missing report fields");
        // The captured client currently sends the category NAME as categoryID.
        if (!categories.some((item) => item.id === report.categoryID || item.value === report.categoryID)) throw fail(400, "Unknown category");
        const id = randomUUID();
        const key = `EVEJS-${id}`;
        const result = collectReport({ root, logsDir: options.logsDir,
          out: path.join(outDir, `${key}.zip`), note: report.summary,
          clientReport: { ...report, id, key, receivedAt: new Date().toISOString() } });
        options.onReport?.(result.zipPath);
        return reply(201, { id, key });
      }
      const upload = /^\/api\/attachment\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(req.url);
      if (req.method === "POST" && upload) {
        const zipPath = path.join(outDir, `EVEJS-${upload[1]}.zip`);
        if (!fs.existsSync(zipPath)) throw fail(404, "Unknown report");
        const file = parseAttachment(req.headers["content-type"], await readBody(req, MAX_ATTACHMENT + 16384));
        // No await between reading and replacing the archive: concurrent
        // uploads cannot overwrite one another's changes in this process.
        const entries = verifyZip(zipPath);
        const name = `client/attachments/${file.name}`;
        const retained = entries.filter((entry) => entry.name !== name);
        const attachments = retained.filter((entry) => entry.name.startsWith("client/attachments/"));
        if (attachments.length >= 16 || attachments.reduce((sum, entry) => sum + entry.data.length, file.data.length) > MAX_ATTACHMENTS_TOTAL) {
          throw fail(413, "Report attachment limit reached");
        }
        const pending = `${zipPath}.pending`;
        try {
          writeZip(pending, [...retained, { name, data: file.data }]
            .map((entry) => ({ zipPath: entry.name, data: entry.data, mtime: new Date() })));
          verifyZip(pending);
          fs.renameSync(pending, zipPath);
        } finally {
          fs.rmSync(pending, { force: true });
          fs.rmSync(`${pending}.tmp-${process.pid}`, { force: true });
        }
        return reply(201, { id: upload[1] });
      }
      throw fail(404, "Unknown endpoint");
    } catch (error) {
      if (!error.status) console.error("[BugReport]", error.message);
      reply(error.status || 500, { error: error.status ? error.message : "Could not save report" });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}

async function startBugReportService(options = {}) {
  const server = createBugReportService(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? PORT, "127.0.0.1", resolve);
  });
  return server;
}

module.exports = { startBugReportService, parseAttachment, PORT };

if (require.main === module) {
  const options = { onReport: (file) => console.log(`Report saved: ${file}`) };
  try {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const key = { "--root": "root", "--logs-dir": "logsDir", "--out-dir": "outDir" }[args[i]];
      if (!key || !args[i + 1]) throw new Error("Usage: node bug-report-service.js [--root dir] [--logs-dir dir] [--out-dir dir]");
      options[key] = args[i + 1];
    }
    startBugReportService(options).then((server) => {
      console.log(`Local bug reports: http://127.0.0.1:${PORT}/api (Ctrl+C to stop)`);
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
        server.close();
        server.closeAllConnections();
      });
    }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
