# Error Report

Packs everything the EvEJS team needs to look into a problem — recent server
logs, crash reports, configuration, and version numbers — into **one zip file**
that you upload by hand (for example to the Discord bug channel).

## Use it

Double-click:

```text
tools\ErrorReport\ErrorReport.bat
```

It asks one optional question ("describe what happened"), figures out whether
this install runs natively or through Docker, and drops a zip like

```text
EveJS-ErrorReport_v0.12.4.1_2026-08-06_153045.zip
```

into the repo root, then opens Explorer with the file selected. Upload that
file. Done.

## What ends up in the zip

For a long login/jump/warp pause, use the root **ProfileServer.bat** launcher.
It starts the native Node server and CPU/GC plus Windows counters, then builds
one report with those files under `profiling/`. Press Enter to finish profiling
early or wait 15 minutes; the server stays running. See
[the profiling guide](../../doc/PAUSE_PROFILING.md). Existing Node servers must be
stopped normally before starting the profiled server. This launcher calls the
native collector directly and does not manage other services.

An existing manual capture can be added with the collector's explicit
`--profile-dir <folder>` option. Only recognized capture files are included;
profiles are never tail-truncated. Raw captures stay on disk after collection.

- `server-logs/` — the log files from the **most recent play session**: every
  file written within 6 hours of the last log activity (the window is anchored
  on the last activity, not on "now", so reporting the morning after a crash
  still captures the crash). Files over 15 MB keep only their tail, marked as
  such. `server.log` always rides along.
- `server-logs/node-reports/` — Node crash reports, if any exist.
- `config/*.json` — the versioned server configuration.
- `client-setup/EvEJSConfig.bat` — the client launcher paths (native installs).
- `manifest.json` — version numbers, system facts (OS, CPU, memory, free
  disk), and a pre-digested count of recent errors with the last few error
  lines, so triage can start without extracting anything.
- `DESCRIPTION.txt` — whatever you typed at the prompt.

**Never collected:** TLS certificates or keys, `.env` files, and the game
database (`_local\gameStore` / the Docker data volume).

The logs and config do contain file paths from your machine and your
character names. Review the zip before sharing if that concerns you.

## Docker installs

The same `ErrorReport.bat` handles Docker automatically:

1. logs are copied out of the `server` container with `docker compose cp` —
   this works **even when the container has crashed or is stopped**;
2. container console output for `init`, `market`, and `server` is captured
   too, which covers failures from before file logging starts (first-run
   database build, market health gate);
3. the collector then runs inside a throwaway `evejs-local` container, so the
   host machine does not need Node.js at all.

On Linux/macOS hosts, run the same steps by hand from the repo root:

```bash
mkdir -p /tmp/evejs-report/logs
docker compose cp server:/var/lib/evejs/logs/. /tmp/evejs-report/logs
docker compose logs --no-color --tail 4000 server > /tmp/evejs-report/logs/docker-compose-server.log
docker run --rm --entrypoint node \
  -v "$PWD:/hostrepo:ro" -v /tmp/evejs-report:/hosttmp evejs-local \
  /hostrepo/tools/ErrorReport/collect-error-report.js \
  --root /hostrepo --logs-dir /hosttmp/logs --out /hosttmp/report.zip --no-prompt
mv /tmp/evejs-report/report.zip ./EveJS-ErrorReport.zip
```

## Options

`ErrorReport.bat` forwards options to `error-report.ps1`:

| Option | Effect |
|--------|--------|
| `-Docker` / `-Native` | Force the install type instead of auto-detecting. |
| `-Hours <n>` | Log window in hours before the last activity (default 6). |
| `-Note "<text>"` | Provide the description up front, skip the prompt. |
| `-OutDir <dir>` | Write the zip somewhere other than the repo root. |
| `-NoReveal` | Do not open Explorer on the finished zip. |

The collector itself (`collect-error-report.js`) also runs standalone with
Node — `node tools\ErrorReport\collect-error-report.js --help` — which is what
maintainers want when reproducing a report locally (`--logs-dir` accepts a
copied-out log folder).

## For maintainers

The zip always contains `manifest.json` (schema `evejs-error-report/1`) with
the version pair (`config/version.json` **and** `package.json` — a mismatch
means a half-updated install), the selection window, per-file truncation
flags, and the error digest. The archive is re-opened and CRC-verified before
the tool reports success; a failed run leaves at most a `*.tmp-*` sidecar,
never a plausible-looking half zip.

## In-game reports (localhost only)

Start `tools\ErrorReport\BugReportService.bat` on the same Windows machine as
the game client, or run this from the repository root with Node.js:

```text
node tools/ErrorReport/bug-report-service.js
```

Keep it running while using the in-game bug-report form. Restart the game
server and reconnect the client after installing this change so the client
receives the new global configuration. The server advertises
`bugReporting_BugReportServer = http://127.0.0.1:26004/api`; this setting cannot
be deleted or overridden through the runtime global-config RPC. The service
binds only IPv4 loopback and has no external upload or relay. If it is stopped,
the form reports that the service is unavailable; it does not fall back to CCP.
The service is launched separately, so it can remain available after a game
server crash. Stop it with Ctrl+C.

Reports appear in `_local/error-reports/EVEJS-<UUID>.zip`. Each includes the
usual server data plus `client/report.json` with the submitted fields, session
information, and computer information. Uploaded screenshots, logs, and the
client's diagnostic `igbr.zip` are retained under `client/attachments/`.
The diagnostic ZIP stays intact inside the report; it is not extracted.
Client diagnostics can include preferences, settings, fitting and crash data
collected by the client itself, beyond the standalone collector's file list.

The client submits the report first, followed by individual attachments. The
initial report immediately produces a usable ZIP. Each accepted attachment
updates that ZIP after CRC verification, preserving the original server-log
snapshot. Failed uploads leave the previous ZIP available; retrying the same
filename replaces it. Uploads can resume against the same report ID after a
service restart. There is no client “all attachments finished” request, so the
ZIP contains all attachments acknowledged so far. The client shows its normal
success or attachment-failure message. Limits are 256 KiB for report JSON,
32 MiB per attachment, 16 attachment names and 128 MiB of attachments per report.

Optional service arguments are `--root <repo>`, `--logs-dir <logs>` and
`--out-dir <destination>`. Run the service on the host, not inside a Docker
container: container loopback is not the client's loopback. For container logs,
`--logs-dir` can point at a copied-out log directory (see the Docker commands
above); refresh that copy before reporting. The standalone `ErrorReport.bat`
continues to collect native or Docker logs as before, without this service or
any client report.

This redirects report submission. The client's separate help and “my bug
reports” website buttons remain part of the original client; this service
does not open those links.

### Harness

```text
node --test server/tests/bugReportService.test.js server/tests/errorReportCollector.test.js
node scripts/Tests/run-isolated-tests.js server/tests/machoNetServiceParity.test.js server/tests/machoNetServerStatusParity.test.js
```

The HTTP harness runs on an ephemeral loopback port with temporary server-log
fixtures. It exercises the captured client's status/category/issue/attachment
sequence, ZIP contents, restart recovery, retries, simultaneous uploads,
rejected requests, and standalone collection. It does not launch the game
client, read real logs, or send requests outside localhost. The configuration
tests use the repository's isolated game-store runner.
