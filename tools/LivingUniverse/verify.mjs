import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "_local/living-universe-audit");
const run = (args) => {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 60000,
    windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return { success: result.status === 0 && !result.error, exitCode: result.status,
    ...(result.error ? { error: result.error.message } : {}), stdout: result.stdout, stderr: result.stderr };
};
const audit = run(["tools/LivingUniverse/audit.mjs", ...process.argv.slice(2)]);
if (!audit.success) {
  process.stderr.write(audit.stderr || audit.error || audit.stdout);
  process.exit(1);
}
const snapshot = path.join(output, "legacy-added");
const cases = [
  { name: "legacy-deadline-queue", args: [path.join(snapshot, "server/scripts/verifyDeadlineQueue.js")] },
  { name: "legacy-roaming-kernel", args: [path.join(snapshot, "server/scripts/verifyLivingRoamingKernel.js")] },
  { name: "legacy-full-crew-fixture", requiresFullLegacyBaseline: true,
    args: ["--test", path.join(snapshot, "server/tests/industrialHirelingNavigation.test.js")] },
  { name: "ledger-governor-and-current-command-boundary", args: ["tools/LivingUniverse/kernelChecks.cjs"] },
];
const results = cases.map(({ name, args, requiresFullLegacyBaseline }) => {
  const startedAt = performance.now();
  const result = { name, ...run(args), durationMs: Math.round(performance.now() - startedAt) };
  result.status = result.success ? "passed" : requiresFullLegacyBaseline && /Cannot find module/.test(result.stdout + result.stderr)
    ? "blocked" : "failed";
  console.log(`${result.status.toUpperCase()} ${name} (${result.durationMs} ms)`);
  if (result.status === "failed") console.error(result.stderr || result.error || result.stdout);
  if (result.status === "blocked") console.log("  Full crew fixture needs baseline inventory/fitting modules; the recovered snapshot contains additions only.");
  return result;
});
fs.writeFileSync(path.join(output, "verification.json"), JSON.stringify({
  generatedAt: new Date().toISOString(), success: results.every((result) => result.success),
  kernelChecksPassed: results.filter((result) => !cases.find((entry) => entry.name === result.name).requiresFullLegacyBaseline)
    .every((result) => result.success),
  scope: "Recovered legacy kernels and the current in-memory command boundary; no server/client boot or world writes.",
  integrationVerified: false, results,
}, null, 2) + "\n");
// A blocked legacy integration fixture is distinct from a failed kernel check.
if (results.some((result) => result.status === "failed")) process.exitCode = 1;
else if (results.some((result) => result.status === "blocked")) process.exitCode = 2;
