import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { builtinModules, createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { parse } from "@babel/parser";

// Static analysis only: never require the game server or execute patch contents.
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const output = path.join(root, "_local/living-universe-audit");
const reference = path.resolve(process.argv[2] || path.join(root, "_local/references/evejs-living-universe"));
const patchDir = path.join(reference, "patches/v0.12.3.1");
const installed = JSON.parse(fs.readFileSync(path.join(patchDir, "installed-manifest.json")));
const baseline = JSON.parse(fs.readFileSync(path.join(patchDir, "baseline-manifest.json")));
const patchPath = path.join(patchDir, installed.patchFile);
const patchBytes = fs.readFileSync(patchPath);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
if (sha256(patchBytes) !== installed.patchSha256.toUpperCase()) throw new Error("Patch checksum mismatch");

const additions = new Map();
for (const chunk of patchBytes.toString("utf8").split(/(?=^diff --git )/m)) {
  const header = chunk.match(/^diff --git a\/(.+) b\/(.+)\r?$/m);
  if (!header || !/^new file mode /m.test(chunk)) continue;
  const relative = header[2];
  if (relative !== header[1] || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").includes("..")) {
    throw new Error(`Unsupported patch path: ${relative}`);
  }
  let inHunk = false;
  let contents = "";
  for (const line of chunk.split("\n")) {
    if (line.startsWith("@@ ")) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+")) contents += line.slice(1) + "\n";
    else if (line === "\\ No newline at end of file") contents = contents.slice(0, -1);
    else if (line !== "") throw new Error(`Unexpected content in added-file hunk: ${relative}`);
  }
  additions.set(relative, Buffer.from(contents));
}

const snapshot = path.join(output, "legacy-added");
fs.mkdirSync(snapshot, { recursive: true });
for (const item of installed.files.filter((item) => item.kind === "added")) {
  const source = additions.get(item.path);
  // The public patch is LF; its Windows installed-file manifest is CRLF.
  const bytes = source && [source, Buffer.from(source.toString("utf8").replace(/\r?\n/g, "\r\n"))]
    .find((candidate) => sha256(candidate) === item.sha256.toUpperCase() && candidate.length === item.size);
  if (!bytes || sha256(bytes) !== item.sha256.toUpperCase() || bytes.length !== item.size) {
    throw new Error(`Extracted source does not match release manifest: ${item.path}`);
  }
  const destination = path.join(snapshot, item.path);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  additions.set(item.path, bytes);
}

const touched = baseline.files.map((item) => {
  const currentPath = path.join(root, item.path);
  const exists = fs.existsSync(currentPath);
  const hash = exists ? sha256(fs.readFileSync(currentPath)) : null;
  const installedHash = installed.files.find((candidate) => candidate.path === item.path)?.sha256;
  let contextApplies = null;
  let contextError = null;
  if (item.kind === "modified") {
    const check = spawnSync("git", ["apply", "--check", "--whitespace=nowarn", `--include=${item.path}`, patchPath], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000,
    });
    if (check.error) throw check.error;
    contextApplies = check.status === 0;
    contextError = contextApplies ? null : check.stderr.trim().split(/\r?\n/).slice(0, 4).join("\n");
  }
  return {
    path: item.path, kind: item.kind, exists,
    baselineMatches: hash !== null && hash === item.sha256?.toUpperCase(),
    installedMatches: hash !== null && hash === installedHash?.toUpperCase(),
    contextApplies, contextError,
  };
});

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "tokens", "comments"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visitor));
    else if (value && typeof value === "object") walk(value, visitor);
  }
}

function literal(node, filename) {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "Identifier" && node.name === "__dirname") return path.dirname(path.join(root, filename));
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = literal(node.left, filename), right = literal(node.right, filename);
    return left !== null && right !== null ? left + right : null;
  }
  if (node?.type === "CallExpression" && node.callee?.type === "MemberExpression" &&
      node.callee.object?.name === "path" && ["join", "resolve"].includes(node.callee.property?.name)) {
    const args = node.arguments.map((argument) => literal(argument, filename));
    return args.every((argument) => argument !== null) ? path[node.callee.property.name](...args) : null;
  }
  return null;
}

function resolveImport(filename, request) {
  if (builtinModules.includes(request.replace(/^node:/, ""))) return { kind: "builtin" };
  if (!request.startsWith(".") && !path.isAbsolute(request)) {
    try {
      createRequire(path.join(root, filename)).resolve(request);
      return { kind: "package" };
    } catch { return { kind: "missing-package", target: request }; }
  }
  const target = path.isAbsolute(request) ? request : path.resolve(root, path.dirname(filename), request);
  for (const candidate of [target, target + ".js", target + ".json", path.join(target, "index.js")]) {
    const relative = path.relative(root, candidate).replaceAll("\\", "/");
    if (additions.has(relative)) return { kind: "legacy-added", target: relative };
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { kind: "current", target: relative };
  }
  return { kind: "missing", target: path.relative(root, target).replaceAll("\\", "/") };
}

const imports = [], parseErrors = [];
const asts = new Map();
for (const [filename, bytes] of additions) {
  if (!filename.endsWith(".js")) continue;
  let ast;
  try { ast = parse(bytes.toString("utf8"), { sourceType: "unambiguous" }); }
  catch (error) { parseErrors.push({ path: filename, message: error.message }); continue; }
  asts.set(filename, ast);
  walk(ast, (node) => {
    if (node.type !== "CallExpression" || node.callee?.name !== "require") return;
    const request = literal(node.arguments[0], filename);
    imports.push({ from: filename, line: node.loc?.start.line, request,
      ...(request === null ? { kind: "dynamic" } : resolveImport(filename, request)) });
  });
}

// Only flag missing named exports when a literal export object can be inspected.
// Spreads and computed assignments are reported as unknown, never as failures.
const exportCache = new Map();
function exportsFor(filename) {
  if (exportCache.has(filename)) return exportCache.get(filename);
  let ast = asts.get(filename);
  if (!ast) {
    try { ast = parse(fs.readFileSync(path.join(root, filename), "utf8"), { sourceType: "unambiguous" }); }
    catch { exportCache.set(filename, null); return null; }
  }
  let keys = null;
  walk(ast, (node) => {
    if (node.type !== "AssignmentExpression" || node.left?.type !== "MemberExpression" ||
        node.left.object?.name !== "module" || node.left.property?.name !== "exports") return;
    if (node.right.type !== "ObjectExpression" || node.right.properties.some((property) =>
      property.type === "SpreadElement" || property.computed)) { keys = null; return; }
    keys = node.right.properties.map((property) => property.key.name || property.key.value);
  });
  exportCache.set(filename, keys);
  return keys;
}
const missingExports = [];
for (const [filename, ast] of asts) {
  walk(ast, (node) => {
    if (node.type !== "VariableDeclarator" || node.id?.type !== "ObjectPattern" ||
        node.init?.type !== "CallExpression" || node.init.callee?.name !== "require") return;
    const request = literal(node.init.arguments[0], filename);
    if (request === null) return;
    const resolved = resolveImport(filename, request);
    if (resolved.kind !== "current") return;
    const keys = exportsFor(resolved.target);
    if (!keys) return;
    for (const property of node.id.properties) {
      const name = property.key?.name || property.key?.value;
      if (name && !keys.includes(name)) missingExports.push({
        from: filename, line: node.loc?.start.line, target: resolved.target, name,
      });
    }
  });
}

const modified = touched.filter((item) => item.kind === "modified");
const runtimeImport = (item) => item.from.startsWith("server/src/");
const report = {
  generatedAt: new Date().toISOString(), currentVersion: JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version,
  referenceCommit: spawnSync("git", ["-C", reference, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim(),
  legacyRelease: installed.release, legacyBaseline: baseline.compatibility.version,
  patchSha256: sha256(patchBytes),
  summary: {
    touched: touched.length, added: additions.size, modified: modified.length,
    modifiedBaselineMatches: modified.filter((item) => item.baselineMatches).length,
    modifiedMissing: modified.filter((item) => !item.exists).length,
    modifiedContextApplies: modified.filter((item) => item.contextApplies).length,
    addedPathCollisions: touched.filter((item) => item.kind === "added" && item.exists).length,
    parsedJavaScript: asts.size, parseErrors: parseErrors.length,
    missingRuntimeImports: imports.filter((item) => runtimeImport(item) && item.kind === "missing").length,
    missingRuntimeExports: missingExports.filter(runtimeImport).length,
    dynamicImports: imports.filter((item) => item.kind === "dynamic").length,
  },
  limits: [
    "Patch context success does not prove semantic compatibility.",
    "Import/export analysis is static; it does not execute modules or prove behavior.",
    "Only newly added JavaScript is analyzed; modified integration files require manual porting.",
    "The extracted snapshot contains additions only, not a runnable legacy server.",
    "No client, server, services, or world database is started or modified by this audit.",
  ],
  files: touched, imports, missingExports, parseErrors,
};
fs.writeFileSync(path.join(output, "compatibility.json"), JSON.stringify(report, null, 2) + "\n");
const unique = (values) => [...new Set(values)];
fs.writeFileSync(path.join(output, "compatibility.txt"), [
  `Living Universe ${installed.release} (${baseline.compatibility.version}) -> EveJS ${report.currentVersion}`,
  JSON.stringify(report.summary, null, 2), "", "Missing runtime dependencies:",
  ...unique(imports.filter((item) => runtimeImport(item) && item.kind === "missing").map((item) => `  ${item.target} <- ${item.from}:${item.line}`)),
  "", "Missing named runtime exports:",
  ...missingExports.filter(runtimeImport).map((item) => `  ${item.name} from ${item.target} <- ${item.from}:${item.line}`),
  "", ...report.limits,
].join("\n") + "\n");
console.log(JSON.stringify({ ...report.summary, report: path.join(output, "compatibility.json") }, null, 2));
