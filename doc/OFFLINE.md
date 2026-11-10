# Offline EveJS

EveJS clients must communicate only with their own EveJS server. Play refuses to
launch until the required patches, local resources, certificate trust,
disabled forwarding and shared gateway TLS pass their checks. PlayDebug uses
the same launcher and gates. A player cannot turn these security checks off.

Two Windows Firewall blocks for the client are recommended on top of those
checks. They are not required: Setup offers them, and Play says plainly when
they are not active and starts anyway. See
[The recommended firewall blocks](#the-recommended-firewall-blocks).

**Local UI revision (2026-10-25), including authored Aura guidance: in-game and live network verification
remain pending.** Automated tests do not establish gameplay or live network behavior.

**Historical live acceptance passed on 2026-09-19 for the former flag-serving
implementation using the complete Windows Security/WFP
and DNS records, with the owner's explicit approval.** Both gameplay passes
succeeded, including a launch with the two client rules disabled. Attributed
records showed no outside traffic, forbidden lookup or UDP from the tested
processes. Audit-health and retention checks passed; both ETW traces reported
zero loss. The text firewall logs lost events, and their original failure reports
remain intact. The owner accepted the complete primary records for these two
captures. Both rules were re-enabled and capture settings were restored.

## What is enforced

- Both launch paths pass `/noCrashReportUpload` and a loopback `/resfileserver`.
  Sentry gets a valid loopback DSN. The EveJS installation's preferences disable
  crash uploads and override Sentry locally; shared live-EVE settings are untouched.
- Launch checks only that the `ResFiles` directory and both nonempty client
  resource indexes exist. It does not scan indexed resources. The local resource
  endpoint returns 404 for cache misses rather than fetching from a CDN.
- Reviewed, hash-checked recipes replace the six native LaunchDarkly URLs and
  the native minidump URL with loopback endpoints. The PE certificate directory
  is removed and the Windows checksum is recalculated. Unknown binary versions
  or unexpected edits fail verification. This permission covers outbound
  containment only; gameplay and feature code patches remain forbidden.
- The proxy has no arbitrary forwarding, upstream gateway or allow-list mode.
  Its only HTTP forwarding target is the configured image service's exact numeric
  origin and path. `localhost` is pinned to `127.0.0.1`; other configured hostnames
  are refused rather than resolved. CONNECT reaches only EveJS's own TLS listener.
  Sentry reports are discarded locally; ipify and other unhandled destinations are
  blocked. No proxy setting can enable outside forwarding.
- LaunchDarkly endpoint strings remain patched to loopback. Local polling and
  streaming enable only Achievements and its character-title rewards. Event
  uploads are discarded; real LaunchDarkly hosts stay blocked. All other keys
  use their [built-in defaults](OFFLINE_CLIENT_FLAGS.md), including XMPP Local
  chat. The retired general flag policy file remains ignored.
- Play requires version 4 offline health status with forwarding disabled,
  `clientFeatureFlags: "local-supported-features"` and exactly the three enabled
  achievement, character-title and local Aura guidance UI flags.
  HTTP and trusted HTTPS health checks reject stale servers or unrelated values.
  HTTPS remains available for the shared gateway and native feature requests.
- Global config cannot publish `monolith_honeycomb_public_write_key`, including
  through the GM runtime override path.
- Each installation generates its own CA and private key. The CA's critical name
  constraints cover only the intercepted names and loopback IP. The retired root
  and unconstrained EveJS roots must be removed from CurrentUser trust and client
  bundles. Leaves have empty subjects and critical SANs; the CA rejects all
  nonempty subjects to prevent Windows common-name fallback from bypassing DNS
  constraints. No CA private key ships in a release.
- The TLS listener selects a DNS-only leaf for permitted DNS names. Numeric
  loopback clients receive the leaf containing the IP SAN. Both use the same
  constrained CA; this avoids the native gateway library's rejection of IP SANs
  under IP name constraints without weakening trust or verification.

Recommended on top of this list, and not enforced: two enabled outbound Block
rules that cover the configured `bin64/exefile.exe` and `bin64/eve_crashmon.exe`,
all protocols and profiles. On every launch Play checks the resolved paths, rule
scope, running firewall service and enabled active profiles. When that check
fails, Play prints a warning and starts; everything in the list above still
applies. See [The recommended firewall blocks](#the-recommended-firewall-blocks).

The owner approved the minidump URL patch and CA rotation before the next launch.
The owner also approved the existing SDE download during setup. That is a
setup-only exception; runtime client/server traffic stays limited to EveJS.
No outside download was performed during this work. The current feature behavior
uses client code defaults with the three supported local achievement/title/Aura UI flags.

## Install the controls

Quit the EveJS client and server first. Use the repository root as the current
directory.

The firewall blocks are recommended, not required. `SetupEveJS.bat` offers them
as its last phase and asks before adding them. Saying no, cancelling the
administrator prompt or having Windows Firewall off does not fail Setup: the
phase shows `[skip]` and Setup finishes. To add the blocks by hand instead, run
this in an elevated PowerShell window **as the same Windows account that plays**.

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\ClientSETUP\scripts\Set-EvEJSFirewall.ps1 -Mode Install -ClientPath "D:\EVE Online - 3396210 - Copy\tq"
```

Expected: `Firewall gate passed`, covering both exact executable paths. Creation
needs elevation; later checks do not (see
[Checking without administrator rights](#checking-without-administrator-rights)).
`SetupEveJS.bat -Only firewall` does the same with one UAC prompt and is safe to
run again.

The certificate migration is required. Run certificate installation in an
ordinary, visible PowerShell window as the
Windows user who plays. CurrentUser trust belongs to that account. Windows can
show **Root Certificate Store** confirmation dialogs while removing the retired
root and installing its replacement. Review and confirm those changes in the
visible window, then wait for the installer to finish and run the check below.
A pending dialog is not a completed migration.

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\ClientSETUP\scripts\Install-EvEJSCerts.ps1 -RotateCa -ClientPath "D:\EVE Online - 3396210 - Copy\tq"
```

Expected: newly generated per-install CA/leaf certificates, removal of retired
CurrentUser roots, updated client bundles and a successful certificate check.
The old SHA-1 fingerprint is `BDAC54736BCC544A2C3DC77294905447FD856FD6`.
Coordinate this rotation with every player using a remote server before reconnecting.
See [Updating](UPDATING.md) for the migration.

These commands are read-only checks and do not need elevation:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\ClientSETUP\scripts\Set-EvEJSFirewall.ps1 -Mode Check -ClientPath "D:\EVE Online - 3396210 - Copy\tq"
```

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\ClientSETUP\scripts\Install-EvEJSCerts.ps1 -CheckOnly -ClientPath "D:\EVE Online - 3396210 - Copy\tq"
```

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\ClientSETUP\scripts\Set-EvEJSClientNetworkPatches.ps1 -Mode Check -ClientPath "D:\EVE Online - 3396210 - Copy\tq"
```

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\ClientSETUP\scripts\Test-EvEJSResources.ps1 -ClientPath "D:\EVE Online - 3396210 - Copy\tq"
```

```bash
SetupEveJS.bat -Status
```

Every named gate except the firewall one must pass before Play starts. Run by
hand like this, the firewall check is strict and fails when the recommended
blocks are not active. Play runs the same check as a warning, and
`SetupEveJS.bat -Status` then shows the firewall phase as `[todo]`, which does
not stop anything. The resource check reads only folder and index metadata so
launch time does not grow with the number of cached resources. It does not
verify individual assets or index contents. Every local client installer refuses a
`start.ini` that does not identify the separate EveJS installation with
`server = 127.0.0.1` and `cryptoPack = Placebo`.

After restarting the updated server, check its HTTP and trusted HTTPS health
responses:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\ClientSETUP\scripts\Test-EvEJSOfflineServer.ps1 -ProxyUrl "http://127.0.0.1:26002/"
```

Expected: forwarding disabled, the three supported local UI flags enabled, and shared
gateway TLS verified. No feature policy file is required. Restart the client too,
then use **EVE menu > Paragon Services > Achievements**; see
[the in-game test steps](ACHIEVEMENTS.md#in-game-testing).

## The recommended firewall blocks

Two outbound Windows Firewall blocks, one for `bin64\exefile.exe` and one for
`bin64\eve_crashmon.exe`, stop the two client programs from reaching anything
outside this computer. They are recommended, not required. Play starts and
Setup finishes when the blocks are missing, Windows Firewall is off, or the
administrator prompt was declined. Play refuses only if you choose the strict
setting below.

Play runs the firewall check on every launch. When it fails, Play prints the
reason and this warning, shows
`Firewall: NOT verified, recommended blocks not active` in the launch summary
and the diagnostics file, and starts the client:

```text
[eve.js] Firewall check failed: <the reason>
[eve.js] WARNING: Windows Firewall is not blocking the EveJS client. The two blocks are recommended, not required, so Play starts anyway.
[eve.js] Run SetupEveJS.bat -Only firewall to add them. Without them, anything the client patches and the proxy miss can reach the internet.
```

Every other gate stays mandatory, including the check that the client is the
separate EveJS copy.

To add the blocks, run this and approve the one administrator prompt:

```bat
SetupEveJS.bat -Only firewall
```

A full `SetupEveJS.bat` run offers the same step and asks first; add
`-Skip firewall` to leave the step out without being asked.
`SetupEveJS.bat -Status` shows the firewall phase as `[ok]` when the blocks are
active and as `[todo]` when they are not. The blocks only work while Windows
Firewall is on.

### Checking without administrator rights

Some Windows installations show the live firewall rule list only to an
administrator: in an ordinary window `Get-NetFirewallRule` fails with
`Access is denied`. The check then reads the same two rules from the saved local
firewall policy in the registry
(`HKLM\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules`),
which every account can read. It applies the same conditions there: enabled,
outbound, Block, the exact program, the `EveJS` group, the expected remote
addresses, and no other condition that would narrow the block. Its pass message
then ends with `Rules read from the saved local firewall policy`.

The saved copy cannot show whether Windows is enforcing a rule. The checks that
the firewall service runs and that every active profile is on and honours local
rules still apply. A check run in an elevated window reads the live rules as
before.

Before 21 October 2026 the check treated `Access is denied` as missing rules. On
those machines Play warned on every launch and Setup offered to add blocks that
were already in place.

To make Play refuse to start without the blocks, add this line to
`tools\ClientSETUP\scripts\EvEJSConfig.bat`:

```bat
set "EVEJS_FIREWALL_GATE=enforce"
```

The only other accepted value is `warn`, the default; any other value stops
Play.

To remove the blocks, run this in an elevated PowerShell window. It removes
every block EveJS added on this computer:

```powershell
Get-NetFirewallRule -Group EveJS | Remove-NetFirewallRule
```

Running without the blocks gives up the one control that also stops
connections nobody has found yet. The endpoint patches, launch switches and
proxy stop the known ones. On
2026-09-19 a full play session with the two rules disabled showed no outside
traffic, but that covered one play sequence on the older flag-serving build;
the current achievement UI build has not had that test yet. A player who uses another
firewall should block outbound traffic from `bin64\exefile.exe` and
`bin64\eve_crashmon.exe` there, to every address except loopback
(`127.0.0.0/8` and `::1`). Play cannot check another firewall.

## Live proof

Start the EveJS server and leave its client closed. Record the server's actual
node PID, executable path and command line. Do not select a process merely because
its name is `node.exe` or `exefile.exe`; live EVE and unrelated Node processes can
be running at the same time. The capture tool checks that the supplied server PID
owns the game listener; use `-ServerPort` if it is not 26000.

In the commands below, replace `12345` with that PID. Use a new output directory
for each pass. Run Begin, End and any Restore command from the EvEJS folder,
elevated as the playing user.

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\ClientSETUP\scripts\Measure-EvEJSOffline.ps1 -Mode Begin -ClientPath "D:\EVE Online - 3396210 - Copy\tq" -ServerProcessId 12345 -OutputDirectory ".\_local\offline-proof\firewall-on"
```

Expected: `Recording`. Begin saves the affected audit-policy bits and firewall
logging settings, temporarily raises Security log capacity to at least 512 MiB,
and gives each profile a fresh allowed/blocked log in the protected Windows
Firewall log directory, with a 32,767 KiB limit. It verifies effective ActiveStore
settings, records active profiles, starts bounded DNS and process ETW traces,
and clears the DNS cache. Retention mode is preserved. It creates no firewall
rule, changes no certificate trust and launches no client.

Use Play normally. Complete login, character select, undock, warp, dock and quit.
Check the default XMPP Local-chat path and record which default features work.
Verify feature requests receive no evaluations or streams.
Then stop the capture:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\ClientSETUP\scripts\Measure-EvEJSOffline.ps1 -Mode End -OutputDirectory ".\_local\offline-proof\firewall-on"
```

Expected: capture files plus restoration confirmed by readback. End retires the
temporary text-log destinations before trace decoding, waits for the writers to
close, and copies the complete files and any rolled files. Every loss marker in
these fresh capture-owned files is a failure, including a marker flushed after
the recorded End time. This automatic result remains unchanged by the owner's
acceptance of the two reviewed captures below; retain it alongside the separate
acceptance record. Exit code 2 means
`REVIEW_REQUIRED`, not success: inspect the evidence below. Exit code 1 indicates an
observed failure or incomplete cleanup. If cleanup fails, retry it explicitly:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\ClientSETUP\scripts\Measure-EvEJSOffline.ps1 -Mode Restore -OutputDirectory ".\_local\offline-proof\firewall-on"
```

Expected: both saved trace sessions stopped and saved audit/logging settings,
including Security log capacity,
restored and read back. Keep `capture-state.json` until recovery is complete.

Review the whole capture window:

1. Check `capture-errors.json`, `RestoreError`, `StopErrors`, and both tracerpt
   summary files. Missing primary evidence, dropped WFP/DNS/process events,
   Security log rollover, a failed stop or uncertain attribution prevents
   acceptance. Preserve supplementary text-log failures for review as well.
   Also check `security-health.json`: audit transport loss, discarded audits,
   log-full and logging-service errors are failures even when record bounds
   show no rollover. This query extends through the completed WFP export to
   include delayed failure notices; a query error is never an empty success.
2. WFP Security events 5156, 5157 and 5152 provide application path, process ID,
   direction, destination and protocol. Match the exact EveJS executable paths.
   Normalize Windows device paths using the saved drive mapping. For Node, match
   the saved server PID/lifetime and its actual descendants from process events;
   do not include unrelated processes using the same Node binary. The report's
   direct-server list is not automatic attribution of every child worker.
3. Confirm no allowed outbound event from either client program or the EveJS
   server goes outside loopback or the configured EveJS address. Check protocol 17
   as well as protocol 6; UDP broadcasts matter. Inspect blocked attempts too.
4. Inspect DNS ETW query-called/query-sent/cache events, using `ClientPID` or the
   event's process ID and process lifetime to identify the caller. There must be
   no EveJS lookup for LaunchDarkly, Sentry, ipify, eveonline or evetech names.
   Keep the post-run DNS cache as supplementary evidence. A cache snapshot alone
   can miss expired/failed queries or include a separate live EVE client's queries.
5. Inspect process image-load event 5 for `TracyClient.dll` under the EveJS client.
   If loaded, establish from the complete WFP capture whether it sends anything,
   including UDP. Its presence on disk alone is not evidence of a broadcast.
6. Retain the copied `<Profile>-pfirewall.log` files, any `.old` files and the
   `FirewallLogArtifacts` source-path record. New captures use fresh
   `%SystemRoot%\System32\LogFiles\Firewall\EvEJS-<capture-id>-<Profile>.log`
   destinations, rather than the shared default `pfirewall.log`. Missing active
   profile logs, changed active profiles or any loss marker prevent a clean
   automatic collector result.
   Text logs supplement WFP; they cannot reliably attribute every packet to an
   executable path. `Get-NetTCPConnection` also misses UDP and short connections.
7. Confirm there is positive evidence of the client and server's legitimate
   traffic and the complete gameplay sequence. An empty capture never proves
   that a launched client stayed offline.

Repeat the entire launch-to-quit capture once with only the two exact EveJS
firewall rules disabled by the owner. This second pass must reproduce the verified
patched binaries, local preferences, proxy/Sentry/resource environment and launch
arguments. Play warns about this state and starts (see
[The recommended firewall blocks](#the-recommended-firewall-blocks)), so the
owner launches this pass through Play itself. If the launcher config sets
`EVEJS_FIREWALL_GATE=enforce`, Play refuses instead: take that line out for
this pass and put it back afterwards. Immediately re-enable those two rules
afterwards and rerun the firewall check.
Do not disable a profile, the firewall
service, a live EVE rule or another application's rules. Starting normally and
only disabling rules after startup does not prove a firewall-free launch.

Name the second directory `firewall-off`; use the same Begin/End/Restore commands
with that directory. Both complete passes must show no LaunchDarkly, crash or
Sentry traffic outside EveJS. Both passes must be repeated for the current achievement UI
revision. The earlier flag-serving captures below are historical evidence.

Certificate tests must establish both allowed and forbidden name behavior.
The following checks are historical results from 2026-09-19. Temporary Node/OpenSSL and Windows SSL-policy tests passed. A separate bounded
harness also loaded this installed client's `python27.dll`, `_ssl.pyd` and
`_socket.pyd`: its OpenSSL 1.1.1g accepted localhost and 127.0.0.1 SAN leaves and
rejected outside DNS, subdomains, outside IPv4/IPv6, CN-only and duplicate-CN
certificates. It used only temporary CAs and loopback listeners. Separate installed
native SDK and gateway checks passed, followed by verified TLS and local flag
delivery during both gameplay passes. These checks do not establish that every
approved gameplay feature was exercised through the UI.

## Clients using a remote server

Every client needs the same patches and exact hashes, crash switch, valid loopback DSN,
separate preferences, quick resource check, current offline health checks and
trusted constrained CA. Players must receive the host's new
**public certificate** and rerun setup after rotation; never distribute its
private key. Remove the retired/unconstrained roots from each player's CurrentUser
store and old client bundles.

An all-address outbound block would also block a remote EveJS server; an Allow
rule cannot override it. The firewall helper's `-RemoteServerAddress <literal-IP>`
mode verifies the same IP in `start.ini`
and creates IPv4/IPv6 block ranges excluding loopback and exactly that server IP.
The helper tests boundary addresses and both address families. No DNS name or
arbitrary list is accepted. Local Setup continues to refuse remote start.ini
values; remote client setup must enforce its own equivalent identity check.

Deleting proxy upstream/mode settings does not require opening arbitrary
forwarding for LAN play: players can use the host's EveJS service endpoints.
The shared local HTTPS service remains available for gateway traffic and health
checks. It must deny feature requests without evaluations or streams, and never
forward original CCP hostnames off-box. Update both server and launcher, and quit
and restart clients so earlier in-memory feature values cannot persist.

## Firewall check became a recommendation (6 October 2026)

By the owner's decision the firewall check is now a recommendation: Play warns
and starts without the two blocks, and Setup offers them without failing. The
two dated records below are left as written and describe the gates of their
day. No live test of the current build with the rules off has been recorded.

## Defaults-only revision verification (20 September 2026)

Commit `560bc4bc7` removes local evaluations, streaming, the policy file and the
Local-chat configuration response. The outbound patches and remaining offline
gates are retained. The empty 404 denial prevents a shared listener's placeholder
response from being mistaken for a successful feature response.

Twenty focused test files passed serially, covering the launcher, feature denials
over HTTP1/HTTP2, proxy forwarding, resources, preferences, firewall, certificates,
configuration, packaging and capture tooling. The configuration inventory test was
updated from 168 to 167 definitions for the removed Local-chat setting. Five
broader require/helper/Abyssal guards passed. Three broader guard files still fail:
fixture identity (`moonMiningBindingRuntime`), the local `agentAuthority` checksum,
and the documented table-ownership issues. All three failures reproduced against
byte-exact pre-edit backups; the current edits were then restored byte-exactly.
Logs are under `_local/offline-defaults/`.

No installed client, gameplay session, native SDK harness or network acceptance
capture was run for this revision. No firewall rule or certificate-store change
was made. The owner deferred live verification. Restart the server and every
client before performing the two full captures above; the earlier results below
do not establish the defaults-only behavior.

## Historical flag-serving implementation and verification record

The following table records this work, not a live-security certification. Test
logs are local at `_local/offline-work/`; they are not distributed or uploaded.
Tests run serially with `node scripts/Tests/run-isolated-tests.js --jobs 1`.

| Step | Change | Commit / verification |
| --- | --- | --- |
|1| Scoped client containment-patch permission | `0f2ee296`; CLAUDE.md records the exception. |
|2| Remove ineffective variables and false launcher claims | `bdbf769b`; mandatory launcher/proxy/certificate checks and rerun recorded in step2 logs. |
|3| Crash switch, valid local Sentry DSN and separate preferences | `a046871f`; step3 tests and guard logs. |
|4| Remove outside proxy forwarding; prevent Honeycomb configuration | `fc674733`; real local HTTP/CONNECT rejection tests trap outbound sockets and DNS; config count guard updated and rerun. |
|5| Complete-cache gate and loopback resource URL | `a7b6e25d`; step5 tests; runtime misses fail locally. |
|6| LaunchDarkly and crash URL recipes and launch-time hash verification | `e706e9db`; temporary-copy and installed-binary Apply/Check passed. Follow-up `71dc221f` changes native flag endpoints to localhost and upgrades the previous exact hash. Installed native initialization and both complete client launches passed. |
|7| Local native flag protocol, explicit policy and readiness gate | `7d1e00fd`; all 17 selected files passed. Follow-up `8d3f2b79` fixes polling and typed numeric comparisons. All 67 approved values were verified through the installed SDK; both flights used gateway Local chat. |
|8| Mandatory Setup/firewall/launcher gates | `8c2264a1`; all 14 selected files passed after fixing the IPv6 range regression and rerunning firewall, preferences and launcher tests. Both rules are now installed; their actual read-only check passes after correcting Windows' empty unrestricted package filter handling. |
|9| Per-install constrained CA and retired-root migration | `37245d18`; all 14 selected files passed, plus the expanded IPv4/IPv6 constraint cases. Windows SSL policy and Node/OpenSSL reject outside SANs, CN-only leaves and duplicate-CN escapes. The owner completed migration and the installed certificate check passes. |
|10| This procedure, flag inventory and capture tool | Documentation and collector checks passed. Both gameplay captures and settings restoration passed. The owner accepted the complete WFP/DNS evidence; the original text-log failure reports remain preserved. |

Follow-up `95635fbc` makes Play and PlayDebug ignore inherited `ERRORLEVEL`
values and treats negative helper exit codes as failures. All 15 selected test
files passed after correcting the new test's repository-root lookup and rerunning
it. The mock launches exercise real launcher gate decisions without running the
client or changing system policy. The release builder also keeps these guides
and requires every offline helper and patch recipe; its packaging guard passed.
Before firewall installation, an actual Play dry run stopped at that gate with exit code 1 and
launched no client. The additional installed-client SSL harness passed all eight
leaf cases; its evidence remains under `_local/offline-work/ca-draft/`.
The initial patched-module import exposed `Config`, `Client` and
`ServiceEndpointsConfig`. That import-only check did not establish flag delivery;
the later native connection checks below exercise it.

The final gameplay captures on 2026-09-19 both completed login, character select,
undock, warp, dock and a clean quit. The normal pass launched through Play. The
second pass launched with only the two exact client rules disabled, using the
verified binaries and launcher environment under a bounded recovery controller.
Actual native TLS and `/meval` requests reached EveJS, and Local chat joined the
gateway with `channel_id=local` in both flights. Each capture's `server-session.log`
retains startup and character flag requests and verified gateway `Notices.Consume`
traffic; `/mobile` was also handled locally. The installed SDK separately read
all 67 approved values. This verifies those values and the exercised flight/chat
behavior; it does not claim UI coverage of every enabled feature.

| Evidence | Firewall enabled | Two client rules disabled |
| --- | --- | --- |
| Capture directory under `_local/offline-proof/` | `gameplay-firewall-on-20260919-r5` | `gameplay-firewall-off-20260919-r3` |
| Client PID | 59748 | 40408 |
| Capture interval, UTC | 21:36:35.987–21:39:47.738 | 21:50:00.105–21:57:02.492 |
| Attributed WFP events / total exported | 40 / 9,660 | 28 / 14,224 |
| Attributed DNS records | 26 | 26 |
| Allowed / denied outside destinations | 0 / 0 | 0 / 0 |
| Attributed UDP events | 0 | 0 |
| Forbidden names in attributed DNS / all DNS / final cache | 0 / 0 / 0 | 0 / 0 / 0 |
| Client Tracy module loads | 1 | 1 |
| DNS / process ETW events lost | 0 / 0 | 0 / 0 |
| Firewall text-log loss | 64 events, reported at 17:40:32 local | 79 events at 17:54:59, plus 49 at 17:57:03 local |
| Original strict acceptance | FAIL: text-log loss | FAIL: text-log loss |
| Final acceptance with owner-approved WFP/DNS evidence | PASS | PASS |

Tracy was loaded in each client, but the attributed WFP capture recorded no UDP.
The late text-log markers were retained: a marker flushed while retiring a fresh
capture log can describe earlier lost events. They cannot be discarded merely
because their timestamps follow End. The original strict acceptance therefore
remains failed solely for this text-log loss. On 2026-09-19, the owner explicitly
approved using the complete Windows Security/WFP and DNS records for final
sign-off despite this loss. Both captures pass that approved review. The separate
acceptance record is `_local/offline-proof/acceptance-20260919.json`, including
SHA-256 hashes of the reviewed evidence and the recovery records. Raw reports
and failed earlier captures are preserved. No launcher gate or automatic capture
failure check was relaxed. This acceptance covers the tested build, installation
and gameplay sequence; it does not claim every gameplay feature was exercised.

A separate elevated read of retained Security events found no audit transport
loss, audit queue overflow, log clearing, log-full, service-stop or processing
failure event (1100, 1101, 1102, 1104, 1108, 4612, 4621) from 21:36:35 through
22:05:04 UTC. The oldest retained record predates both captures, so this review
covers both flights and their exports. Each capture contains the supplementary
`audit-health-review.json` and the exact query script. Record bounds alone would
not establish the absence of audit transport loss. The new shipped health-query
helper independently repeated this read through 22:09:01 with no events or
errors; its result is retained as `shipped-security-health.json`.

The disabled-rule client exited with code 0 at 21:56:42.036 UTC. Both exact rules
were enabled again by 21:56:55; the independent watchdog acknowledged restoration
at 21:56:59, with no recovery errors. The final firewall check passed. All firewall
profiles remain enabled. Capture End readback confirmed the saved logging settings
were restored: allowed/blocked logging off, default `pfirewall.log` paths and
4,096 KiB limits. The Security log returned to its 20 MiB circular configuration.
Server PID 56480, its five children, both clients and all audit helpers are stopped.
The read-only post-approval snapshot in
`_local/offline-proof/acceptance-cleanup-20260919.json` confirms no captured process
IDs remain, both rules are enabled, the firewall service is running and the
saved logging configuration remains restored.

Earlier captures exposed native TLS and collector defects; their failed evidence
remains local and is superseded for current behavior by the two runs above.
`71dc221f` changed native flag endpoints to localhost with an exact-hash upgrade,
and `71782cfa` added the DNS-only SNI leaf without weakening the constrained CA.
`68846f47` raised temporary Security log capacity; `a10736ff` corrected audit-policy
updates, decoded event arrays and trace cleanup. Collector follow-up `a5814a26f`
uses fresh per-profile protected logs, checks effective settings and active
profiles, retires its writers before decoding, and checks the full closed files
for loss. These changes preserve a failed result when evidence is incomplete.
Follow-up `a9ff284b` separately exports Security audit-health events and rejects
transport loss or logging failures, including notices after the gameplay interval.

The final regression run passed all 18 selected files serially: eight in
`_local/offline-work/gameplay-final-tests-1.log` and ten in
`_local/offline-work/gameplay-final-tests-2.log`, with no failed or timed-out files.
After the audit-health guard, all nine capture/proxy/certificate/launcher files
passed again in `audit-health-final-tests.log`; its live read also passed.
After the owner's acceptance decision, those nine files passed again in
`owner-acceptance-tests.log`, and the installed firewall check passed.
The earlier 18-file SNI run also passed in `sni-tests-1.log` and `sni-tests-2.log`;
installed native TLS checks are in `native-server-sni.log`.

The approved profile (`098d2767`), installed Windows firewall check (`cb3542cb`),
TLS health endpoint (`31ed7015`) and exact JSON name/type gate (`749b8b20`) remain
enforced. Certificate migration is complete. An isolated check of all 36 original
Sentry SDK bytecode files, verified against `code.ccp`, initialized SDK 0.8.0 with
`http://evejs@127.0.0.1:26002/1`. Default integrations were disabled and an in-memory
transport was used; socket, DNS, thread and subprocess attempt counts stayed zero.
This proves DSN acceptance without sending a report, not a forced-crash exercise.

The broader require-cycle, helper-duplication and Abyssal convergence guards
passed. The store-isolation guard initially failed live-store comparisons while
the gameplay server was running and exceeded the default 120-second file budget.
With the server stopped and a 480-second budget, all 34 cases passed in 228 seconds
without source changes (`store-guard-server-closed.log`).

`fixtureIdentityGuard.test.js` already fails on unchanged
`moonMiningBindingRuntime` fixture literals. That failure was reproduced using a
byte-exact backup/restore of the edited files rather than `git checkout` and must
not be reported as a new offline regression. See [Test baseline](TEST_BASELINE.md).
The broader build checksum guard also reproduced the baseline failure for local
`agentAuthority/data.json`; no static data checksum was changed to hide it.
The table-ownership guard matches the documented missing classifications for
`researchFieldAuthority` and `stationDockingPlacements`, plus the existing
`nativeNpcWreckService` and `salvagerRuntime` custody violations.
Other failures must be attributed the same way. Never replace a failed live
acceptance result with a passing source-text or hash test.
