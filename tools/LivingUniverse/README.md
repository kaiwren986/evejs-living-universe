# Living Universe investigation and headless checks

The investigation below describes the original compatibility audit. The new
standalone crew slice is now implemented separately; see
[Crew slice and X-Command](../../doc/CREW_SLICE.md). Its tests run with
`npm run test:crew` and do not depend on the blocked historical fixture.

Investigation date: 2026-10-31. Current server: EveJS `261028.1`.
Reference: `kaiwren986/evejs-living-universe`, commit
`0a52a5b0ea84d40dbadec96250011cefa85c4035`, release `v0.2.2`, targeting
the exact `v0.12.3.1` baseline. This directory contains investigation tooling;
Living Universe and X-Command have **not** been installed or enabled.

## Run without EVE

From the repository root:

```powershell
npm run audit:living-universe
npm run verify:living-universe
```

These commands do not launch EVE, boot the game server, open the world database,
or change gameplay configuration. The audit extracts only added source files
into `_local/living-universe-audit/legacy-added/`; every extracted file must
match the release manifest's SHA-256 and byte length. It never applies the
patch. Requires the reference clone at
`_local/references/evejs-living-universe/` (or pass its path after `--`).

Outputs in `_local/living-universe-audit/`:

- `compatibility.json`: file hashes, patch-context checks, imports and named exports.
- `compatibility.txt`: compact compatibility results.
- `verification.json`: check outcomes and full captured diagnostics.

Verifier exit codes: `0` all scheduled checks passed; `1` a check failed;
`2` recovered kernel checks passed but a legacy fixture is blocked by missing
baseline dependencies. A blocked fixture is never counted as a passing test.

## Findings

The public patch affects **200 paths: 136 additions and 64 modifications**.
Of the modified paths, only two match the original baseline byte for byte;
61 differ and one is absent. Only 17 pass a current `git apply --check` context
check. Context matching alone says nothing about behavioral compatibility.
All 130 added JavaScript files parse successfully.

| Area | Evidence and port requirement |
| --- | --- |
| Configuration | Current `server/src/config/` uses domain schemas and `config/*.json`. It has none of the old Living Universe, crew, estate or X-Eve flags. Add a current schema/domain instead of replacing its manager with the old config file. |
| Startup | The old patch hooks `server/index.js`; current startup is in `server/bootstrap.js`. Integrate through explicit boot/shutdown stages that headless callers can disable. |
| Persistence | The old X-Eve bridge depends on manual flush control, flush prerequisites and persistence suspension. Current gameStore/repository does not expose those controls. Preserve source-before-sink ordering and quarantine semantics when adapting to current process ownership and persistence journaling. |
| Tables | Register new tables and row collections in current SQLite metadata and table ownership. Adding service files alone cannot make their state durable. |
| Estate wallet | Old code imports `applyCorporationWalletOperation` and `getCorporationWalletOperation`; current `corpWalletState.js` exports neither. Adapt to the current wallet command authority with durable operation receipts and reconciliation. |
| Prologue ship setup | `boardDockedPreparedShip` and `stagePresetShipForLocation` still exist internally in `devCommandShipRuntime.js` but are not exported. Add an intentional owner API rather than reaching into private helpers. |
| Chat | The old `webChatGatewayService.js` integration target is absent. Current browser chat uses `localChatGatewayService.js`; rework presence projection and subscriptions. |
| Market | The patch changes both JS procurement and Rust RPC/state. Stable fill identities, item custody, funded payment and retry reconciliation must be verified together. |
| NPC physics | Port observation, materialization, death, drone ownership and scene lifecycle hooks into current native-NPC/space code. The isolated roaming test does not verify ship presentation. |

The static audit finds no missing runtime *file paths* after combining old
additions with current files, but finds four missing named exports. That does
not validate the rest of the API: lazy imports, object-method calls, changed
semantics and integration hunks need separate review. The snapshot is not a
complete historical server.

## What already passes headlessly

- Original deadline-queue verifier: deterministic ordering, rescheduling,
  removal and sorting/draining 100,000 entries.
- Original roaming-kernel verifier: deterministic state, patrol/camp contacts,
  stale-contact handling and bounded decision work.
- Focused recovered crew navigation: timed legs, serialized catch-up,
  retry/conflict handling and invalid-route rejection.
- Recovered X-Eve ledger using its own memory repository: balanced transfers,
  duplicate suppression, conflicting operation IDs, insufficient funds,
  serialized replay and corrupt-balance rejection during audit/recovery.
- Recovered load governor: healthy, warning, overloaded, shed and unplayable modes.
- Current character-command runtime with memory handlers: concurrent retries,
  completed replay, conflicting IDs, stale versions and retail-control rejection.

The full original crew-navigation fixture is **blocked before its assertions**:
the additions-only snapshot lacks the baseline inventory/fitting dependencies
imported by the doctrine catalog. No stubbed item/fitting implementation is
substituted to make that integration suite appear green. The smaller pure
navigation check runs independently.

Ledger checks use serialized memory snapshots, not disk power-loss recovery.
They do not prove SQLite durability, wallet/item/market settlement, live NPC
behavior, client notifications or frame/tick performance in a running world.

## Rebuild X-Command on current services

X-Command's web UI, API and account-linking code are intentionally absent from
the old repository. Rebuild it as a local browser companion. The current server
already supplies a `/_evejs-web/v1` gateway, account/character selection,
snapshots, skill data, event streams and service-call authorization. Extend
that integration boundary; do not create a second database writer or duplicate
pilot simulation in the browser.

Suggested first screens: crew roster/orders, travel/jobs, estate stock/projects,
and adventure progress (skills, earned SP and objectives). Show authoritative
server state and operation status rather than deriving completion from UI timers.

One concrete constraint: the existing `OFFLINE_COMPANION` command policy rejects
commands while the same character is controlled by EVE. Crew/corporation
management therefore needs an explicit authorization path that can coexist
with the pilot, rather than claiming the pilot-control lease. The current
command cache is process-local; business effects still require durable owner
receipts. Old navigation retains only 16 recent command IDs, which is useful
for immediate retry handling, not a permanent payment/recruitment ledger.

## Proposed implementation order

1. **Headless integration foundation.** Add a disposable test-store helper,
   explicit world/listener/timer controls and seeded scenario fixtures. Current
   `bootWorld` already exposes stage switches; the packaged release does not
   include the `server/tests/helpers/isolatedGameStore.js` runner referenced by
   its isolation guard. Preserve those guards when creating a compatible helper.
2. **Crew vertical slice.** Port contracts, virtual navigation and cargo custody
   for one crew across a few systems. Verify order replay, pause/resume, restart,
   expiry, loss and delivery conservation. Add roster/status/orders through the
   gateway after the owner APIs work.
3. **One production chain.** Ore -> minerals -> ammunition, with stock reserved
   before travel and delivery/consumption applied once. Restore X-Eve observation
   and its persistence circuit before allowing it to mutate native assets.
4. **RPG progression.** Use the current training-speed setting and native free-SP
   interface. Add active rewards from confirmed outcomes with persisted event
   IDs, pilot/drone credit and replay checks. Training multiplier/reward values
   remain tunable; no gameplay values have been changed by this investigation.
5. **Estate and authored adventure.** Port restoration projects and a short
   prologue, then expand the cast and regional activity. Begin with a small
   meaningful population; the old 5,000-pilot profile is not a prerequisite.

Use separate injected clocks for world simulation and real-time leases/receipts.
Decide paused-world versus offline catch-up behavior explicitly; do not speed
up `Date.now()` globally. Keep deterministic seeds and simulated deadlines so
long scenario tests do not wait through real travel timers.

Future acceptance suite: no cargo/money/SP duplication after replay; recovery
after failure at each reservation/payment/delivery step; unchanged outcomes
across serialization; physical NPC budgets; command ownership; and bounded work
under load. Reserve EVE launches for milestone checks of presentation, combat
effects and notifications that backend tests cannot establish.

## Reference material

- [Published patch](https://github.com/kaiwren986/evejs-living-universe)
- Old `docs/ARCHITECTURE.md`, `docs/X_EVE.md`, `docs/FAMILY_ESTATE.md` and the
  patch's verification scripts are design/source evidence, not current behavior.
- Current `server/bootstrap.js`, `server/src/gameStore/persistenceRoles.js`,
  `server/src/_secondary/express/evejsWebGateway.js` and
  `server/src/services/online/characterCommandRuntime.js` define the relevant
  current integration boundaries.
