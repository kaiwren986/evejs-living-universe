# Configuration

The patch installs code but does not automatically enable the simulation. Its
principal feature gates default to `false` so an administrator can introduce
systems gradually and observe their cost.

Configuration can be supplied through the target server's private
`evejs.config.local.json` or the corresponding `EVEJS_*` environment variables.
Local configuration, credentials, addresses, certificates, and databases should
never be committed to this patch repository.

## Conservative first run

After the normal EveJS configuration pass has created or updated
`evejs.config.local.json`, add these properties to its existing top-level JSON
object:

```json
{
  "livingUniverseEnabled": true,
  "livingUniversePopulationSize": 400,
  "livingUniverseMaxMaterializedPerSystem": 48,
  "livingUniverseMaxMaterializedGlobal": 120,
  "livingUniverseMaterializationsPerTick": 2,
  "livingUniverseSchedulerBudgetMs": 8,
  "livingUniverseMaxDueFlightsPerTick": 64,
  "livingEconomyEnabled": true,
  "livingConflictEnabled": true,
  "livingConflictCampaignsEnabled": true,
  "livingUniverseOffGridTravelTimeMultiplier": 1
}
```

This is a fragment, not a complete configuration file. Do not replace the
existing object with it.

## Principal feature gates

| JSON key | Environment variable | Default | Purpose |
| --- | --- | ---: | --- |
| `ambientTrafficEnabled` | `EVEJS_AMBIENT_TRAFFIC_ENABLED` | `false` | Small authored convoy pilot, separate from the distributed population. |
| `livingUniverseEnabled` | `EVEJS_LIVING_UNIVERSE_ENABLED` | `false` | Persistent pilots, virtual travel, and observed materialization. |
| `livingEconomyEnabled` | `EVEJS_LIVING_ECONOMY_ENABLED` | `false` | Conserved regional stock, mining, hauling, procurement, and production. |
| `liveEventsEnabled` | `EVEJS_LIVE_EVENTS_ENABLED` | `false` | Deadline-driven optional event framework. |
| `xEveEnabled` | `EVEJS_X_EVE_ENABLED` | `false` | Experimental economic kernel and adaptive scheduler. |
| `familyEstateEnabled` | `EVEJS_FAMILY_ESTATE_ENABLED` | `false` | Optional shared-corporation estate and restoration flow. |

Some dependent settings default to `true`, but remain inert while their parent
feature gate is off. In particular, conflict settings do nothing without the
Living Universe, and estate logistics require the estate plus the relevant
economy and traffic systems.

## Population and physical presence

| JSON key | Default | Meaning |
| --- | ---: | --- |
| `livingUniversePopulationSize` | `400` | Persistent pilot count; accepted range is 1-5000. |
| `livingUniverseMaxMaterializedPerSystem` | `48` | Maximum physical simulation in one occupied system. |
| `livingUniverseMaxMaterializedGlobal` | `120` | Shared global physical-NPC budget. |
| `livingUniverseMaterializationsPerTick` | `2` | Flight groups allowed to materialize per one-second scheduler pass. |
| `livingUniverseSchedulerBudgetMs` | `8` | Soft work budget per living-universe scheduler pass. |
| `livingUniverseMaxDueFlightsPerTick` | `64` | Maximum unobserved flight transitions handled per pass. |
| `livingUniversePilotSyncBatchSize` | `128` | Maximum changed synthetic Local records synchronized per pass. |

A larger persistent population is comparatively cheap while virtual. Physical
caps, scene entry, combat, and player-observed behavior are more expensive.
Increase population and physical caps independently.

Recommended population steps are 400, 1000, 2500, then 5000. Measure each stage
before continuing. A maximum accepted configuration value is not a capacity
promise for a particular host.

## Economy controls

| JSON key | Default | Meaning |
| --- | ---: | --- |
| `livingEconomyPulseSeconds` | `15` | Interval between bounded economy passes. |
| `livingEconomyWorkBudgetMs` | `4` | Maximum synchronous work slice before yielding. |
| `livingEconomyStockReconcileBatchSize` | `320` | Minimum stock rows checked from one region per pulse. |
| `livingEconomyFullStockReconcileSeconds` | `14400` | Four-hour target for a rolling full stock review. |
| `livingEconomyRoutePlanningSeconds` | `300` | Minimum interval between universe freight-opportunity rebuilds. |
| `livingEconomyMaxActiveJobs` | `320` | Global reserved or in-transit freight cap. |
| `livingEconomyMaxJobsPerPulse` | `24` | Maximum new freight reservations per pulse. |
| `livingEconomyMaxActiveIndustryJobs` | `320` | Global persistent NPC industry cap. |
| `livingEconomyMaxProductionRunsPerPulse` | `24` | Maximum new industry jobs installed per pulse. |
| `livingEconomyTelemetryIntervalSeconds` | `600` | Ten-minute economic snapshot interval. |

The default production time scale is `1`, meaning normal modeled blueprint
time. `livingEconomyIndustryTimeScale: 0.1` is a 10x development accelerator;
use it for short tests, not balance or production-play conclusions.

## Off-grid travel acceleration

`livingUniverseOffGridTravelTimeMultiplier` defaults to `1`. A value of `10`
makes eligible empty-system virtual legs advance ten times faster. It does not
speed up a materialized ship or a flight in a system with a connected player
scene. If observation begins during an accelerated leg, remaining time is
rebased to normal timing instead of teleporting the ship.

Use `10` only to shorten development tests. Use `1` for ordinary play,
transit-time validation, balance observations, and performance comparisons.

Environment-variable equivalent:

```powershell
$env:EVEJS_LIVING_UNIVERSE_OFFGRID_TRAVEL_TIME_MULTIPLIER = '10'
```

Remove that process-local override after the test.

## X-Eve admission controls

X-Eve is independently gated and disabled by default. Its important latency
defaults are:

| JSON key | Default | Behavior |
| --- | ---: | --- |
| `xEveSchedulerBudgetMs` | `2` | Healthy-load work budget per pass. |
| `xEveTickWarningMs` | `120` | Rolling p95 where planning and maintenance defer. |
| `xEveTickOverloadMs` | `130` | Rolling p95 where only small due continuations are admitted. |
| `xEveEmergencyShedMs` | `500` | Single-tick boundary that immediately stops background work. |
| `xEveRecoveryThresholdMs` | `115` | p95 required before the recovery window can begin. |
| `xEveRecoverySeconds` | `5` | Healthy interval required before normal planning resumes. |

Do not raise the warning or overload thresholds to hide a capacity problem.
Reduce physical caps or background work first.

## Change discipline

1. Keep a copy of the last known-good private configuration.
2. Change one capacity family at a time.
3. Warm up the server before comparing telemetry.
4. Compare p95 tick interval, maximum tick work, scheduler backlog, memory, and
   economy throughput.
5. Revert the change if latency or backlog does not stabilize.

See [Performance](PERFORMANCE.md) for the measurement targets.
