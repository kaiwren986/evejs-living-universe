# Capturing long server pauses

Use this when login, system entry, alignment or landing freezes for several seconds.
The capture runs in the main Node server process and covers work outside scene ticks.
It is off by default. No game database changes or market/Docker changes are needed.

## One-click capture on Windows

Stop the existing Node game server normally, then double-click **ProfileServer.bat**
in the EveJS folder. Use an already configured native install. The launcher checks
that the game port is free, starts the server with CPU/GC and scene profiling,
and starts hidden Windows counters for that exact server PID. Other services stay
running. It does not invoke the deployment-detecting ErrorReport orchestrator.

Launch the client with `Play.bat` and reproduce the pause. **Press Enter in the
profiling window** to finish early, or wait for the default 15-minute capture.
The launcher stops both captures, saves the final CPU segment, and automatically
builds **one ErrorReport ZIP containing the profiles, counters and normal report**.
Explorer selects the ZIP. Send that file with the time/action you observed.
The game server stays running; Ctrl+C stops it normally and also finishes the
report if profiling is still active. Do not close the window with its X button
while the final report is being built.

The ZIP is created beside `ProfileServer.bat`, with a unique name beginning
`EveJS-ErrorReport_profile_`. Its `profiling/launcher.json` identifies the PID,
capture stop reason and whether both captures completed. Startup or counter
failures still produce a report marked partial. A full disk or failed ZIP write
prints the preserved raw capture path. Profiles are included intact; exceeding
the 250 MiB profiling budget fails explicitly instead of truncating them.

No environment flags need setting or clearing for this launcher. Existing
`EVEJS_DATA_ROOT`, game bind/port and profile-directory overrides are honored.
For a different duration or output path:

```powershell
.\ProfileServer.bat --seconds 600 --note "warp landing pause"
.\ProfileServer.bat --out D:\Captures\pause-report.zip --no-reveal
```

The launcher and its dependencies ship in lean ReleaseBuilder output, including
the Windows counter script and this guide. This workflow uses native Windows
Node.js and the existing configured server; it does not run setup or install
dependencies automatically.

## Manual capture (optional)

1. Stop the existing **Node game server** normally with Ctrl+C. Leave your other
   services running. Environment settings take effect when the Node process starts.
2. Open PowerShell in the EveJS checkout and run:

   ```powershell
   $env:EVEJS_PAUSE_PROFILE = '1'
   $env:EVEJS_PAUSE_PROFILE_SECONDS = '900'
   $env:EVEJS_TICK_PROFILE = '1'
   .\StartServer.bat
   ```

   Choose **1 — Server only**. Launch the client through `Play.bat` as usual.
   Keep your existing data-root/launcher settings. Do not run a second game server.

3. Look for the startup message:

   ```text
   [PauseProfile] pid=12345 capturing 900s in ...\logs\pause-profiles\<capture-folder>
   ```

   The default parent is `_local\logs\pause-profiles`; `EVEJS_DATA_ROOT` moves
   it with the rest of your logs. To use another local disk, set
   `$env:EVEJS_PAUSE_PROFILE_DIR = 'D:\EveJSCaptures'` before starting.
   The printed path is authoritative. Each run creates a new folder.

4. In a **second PowerShell window**, opened in the same checkout, paste the
   printed capture-folder path below. This records Windows process and memory
   counters independently of the blocked Node event loop:

   ```powershell
   $capture = 'C:\path\printed\by\PauseProfile'
   $profileStart = Get-Content -LiteralPath (Join-Path $capture 'events.jsonl') -TotalCount 1 | ConvertFrom-Json
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Diagnostics\capture-process-counters.ps1 -ServerProcessId $profileStart.pid -OutputPath (Join-Path $capture 'windows-counters.jsonl') -Seconds 900
   ```

   It targets the PID from the capture, rather than guessing among Node processes.
   It only reads counters and writes that new JSONL file. Counter names use CIM
   properties, so the script does not depend on English Performance Monitor labels.

5. Reproduce the lag: log in, board/undock the affected fitting, jump and warp.
   Note the real-world time and what you were doing when a pause occurred.
   After recovery, stop the game server normally with Ctrl+C to save its last CPU
   segment, or let the 15-minute capture finish automatically while the server
   continues running. Look for `[PauseProfile] finished (...)`.

   The Windows script stops after its duration or when the target exits. Its
   duration includes query time; `queryMs`/`elapsedMs` show the actual cadence.

6. Zip the **whole capture folder**, plus make the usual ErrorReport covering
   that interval:

   ```powershell
   Compress-Archive -LiteralPath $capture -DestinationPath "$capture.zip"
   .\tools\ErrorReport\ErrorReport.bat
   ```

   For this manual workflow, send both ZIPs and the incident time/action. Ordinary
   ErrorReport does not scan old profile folders automatically. Alternatively,
   include the specific capture in one report with
   `node tools/ErrorReport/collect-error-report.js --profile-dir "<capture-folder>" --no-prompt`.
   Do not send just one CPU segment: an incident can span two segments.

The capture limit is measured from process startup, including bootstrap. The
default is 900 seconds; `EVEJS_PAUSE_PROFILE_SECONDS` accepts 1–3600 seconds.
Invalid values use the default. Profiling has overhead: use it for reproduction
runs. Remove the flags before the next ordinary start:

```powershell
Remove-Item Env:EVEJS_PAUSE_PROFILE -ErrorAction SilentlyContinue
Remove-Item Env:EVEJS_PAUSE_PROFILE_SECONDS -ErrorAction SilentlyContinue
Remove-Item Env:EVEJS_PAUSE_PROFILE_DIR -ErrorAction SilentlyContinue
Remove-Item Env:EVEJS_TICK_PROFILE -ErrorAction SilentlyContinue
```

## What the capture contains

| File | Evidence |
|---|---|
| `events.jsonl` | UTC and monotonic timestamps; one-second sampler gaps; event-loop delay/utilization; process CPU deltas; RSS/heap/external memory; supported resource counter deltas; GC batches; CPU segment boundaries; capture start/stop/errors. |
| `cpu-001.cpuprofile`, etc. | Main-isolate V8 stack samples at a requested 2 ms interval, saved about once a minute and at normal capture shutdown. Sampling is already active when the pause starts. |
| `windows-counters.jsonl` | Separate-process CPU, working set/private memory, I/O and page-fault rates; system-wide available memory and paging input/output. |
| Normal server logs | RPC durations, system preparation, late-landing warnings, scene tick breakdowns and the player's actions. |

CPU profiling uses an in-process Inspector session; it opens no debug listening
port. Do not combine this capture with another CPU profiler on the same process.
The hook is installed before world bootstrap imports, and normal store shutdown
awaits the last segment. No simulation or game-state work is delegated elsewhere.

Completed profiles survive an abrupt process termination, but a force-kill or
crash can lose the current partial segment and buffered events. The startup
metadata records Node version, platform, PID and sampling configuration. Watch
for `cpu-error`, output failure messages, missing `stop`, or nonzero
`droppedRecords`; those mean the capture is incomplete. There is no automatic
deletion of older run folders. Each run stops recording at its duration limit;
remove old captures after saving the evidence you need.

## Reading a pause

```powershell
Get-Content -LiteralPath (Join-Path $capture 'events.jsonl') |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object type -eq 'stall' |
  Select-Object utc, gapMs, lagMs, processCpuPercentOfOneCore, clockStepMs
```

`gapMs` is the elapsed monotonic time since the previous sample. `lagMs` is
that gap minus the expected one-second sampling interval; a value at least
1000 ms emits a `stall` record. This is observed timer lateness, not the exact
start/end of a synchronous call. `clockStepMs` compares the wall-clock gap
against the monotonic gap, so a clock correction alone does not become a stall.
The delay histogram may expose the same interruption on a neighboring sample
because its callback and the sampler can run in either order after recovery.

Find `cpu-profile` entries whose `startMonoMs`/`endMonoMs` overlap the stall's
`intervalStartMonoMs`/`intervalEndMonoMs`, then inspect those `.cpuprofile` files
in a CPU profile viewer. Profile serialization/write time is recorded as
`writeMs` so capture overhead is visible too. There are small gaps between
sampling segments; the boundary records expose them.

GC callbacks arrive after execution resumes. Their `startMonoMs`/`endMonoMs`
and the `longest` event intervals describe when collection occurred, rather
than treating callback delivery time as collection time. Every batch retains
counts and total duration by kind, plus its 32 longest individual intervals.
`omittedEventDetails` counts the shorter events whose individual details were
omitted; their counts and durations are included in the totals. GC phase totals
can overlap and should not be treated as an exact stop-the-world percentage.

- Large gap, high process CPU and a matching sampled stack: investigate that
  synchronous work. Process CPU includes other threads and can exceed 100% of
  one core; the CPU profile and GC events cover the main isolate.
- GC intervals overlapping the pause: inspect the GC kinds/durations and heap
  change. Heap size alone does not establish GC as the cause.
- Large gap with little process CPU: investigate blocking I/O, OS scheduling,
  suspension, console output and paging. Event-loop utilization alone does not
  distinguish these from CPU work.
- Falling working set with high process fault rates and system page-ins is a
  paging lead. Process faults include soft faults; system paging counters cover
  every process. Neither proves that this Node process incurred hard faults.
  Node's unsupported Windows page-fault/context-switch fields are emitted as
  `null`, even if the runtime returns a number. Use the Windows capture for this
  part of the investigation.

The scene breakdown enabled by `EVEJS_TICK_PROFILE=1` helps identify expensive
scene work. A login handler can block the process between scene ticks, so match
it with the process capture and RPC logs instead of relying on that breakdown
alone. The capture provides evidence for attribution; it does not label every
large gap as GC, paging or a particular service automatically.

API basis: [Node CPU profiling](https://nodejs.org/api/inspector.html#cpu-profiler),
[event-loop/GC measurements](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html),
and [resource counter platform limits](https://nodejs.org/docs/latest-v24.x/api/process.html#processresourceusage).
