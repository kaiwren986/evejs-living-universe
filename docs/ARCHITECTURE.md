# Architecture

The Living Universe patch models a large population without keeping every NPC
ship in the expensive player-visible space simulation at all times. A pilot is
persistent; a physical ship is a temporary representation created when the
world needs observable fidelity.

## Design goals

- The universe continues to travel, mine, haul, manufacture, trade, fight, and
  lose ships without depending on a nearby player.
- Distant work consumes real modeled time and conserved resources without a
  per-ship 100 ms update loop.
- The same activity becomes physically visible when a player is present.
- Materialized NPCs use native hulls, fittings, movement, weapons, modules,
  effects, wrecks, and drops rather than decorative proxies.
- Background work is bounded, resumable, measurable, and deferrable under load.

## Simulation layers

### Persistent pilot and flight state

Pilots have stable identities, names, portraits, affiliations, roles, skills,
and doctrine assignments. Flights carry their current route, phase, deadline,
ship composition, task, cargo responsibility, and recovery identity. Restarting
the server does not intentionally collapse every pilot back into one station.

Roles are operational rather than permanent character classes. A suitable
pilot can move between mining, hauling, industry support, security, or combat as
demand and doctrine permit.

### Deadline-driven virtual space

Unobserved travel and work are represented by a next useful deadline. The
scheduler advances records that are due, within a time and item budget, and
leaves the rest queued. It does not run thousands of empty-space ships through
the normal 100 ms physical tick.

Travel time is derived from the route, hull, movement phases, and system
crossings. Virtual does not mean instant. The optional 10x multiplier changes
only eligible unobserved development-test legs.

### Player-proximity materialization

When a player can observe a flight, the runtime reserves from global and
per-system physical budgets and creates native ships in the appropriate scene.
They use authored arrival, gate, station-undock, belt, approach, align, warp,
weapon, module, and departure behavior. When observation ends and it is safe to
do so, durable virtual state resumes.

This is not a spawn bubble centered on the player. Actors already have routes,
origins, destinations, and work. Player presence changes representation and
fidelity, not the underlying reason for the activity.

### Living economy

The economy connects stock, demand, procurement, mining, freight, and industry:

1. Stations and regions expose stock, demand, and production opportunities.
2. Mining and procurement provide basic inputs.
3. Industry reserves inputs for timed manufacturing, research, or copying work.
4. Freight planning reserves cargo at a real source before a hauler departs.
5. The destination receives cargo only after the assigned trip completes.
6. Wallet, stock, job, and telemetry receipts make settlement replay-safe.
7. Loss or cancellation follows an explicit recovery or refund path rather than
   silently duplicating cargo or money.

The player can sell into NPC corporation demand and observe or compete with
haulers, but the player is not required to keep the underlying economy alive.

### Conflict and replacement demand

Pirate, civilian, corporate, and security flights can enter campaign encounters.
When observed, combat is represented with physical ships and native effects.
When sufficiently distant, a bounded deterministic resolution can produce the
same durable categories of outcome. Ship loss consumes assets and creates
replacement demand for industry and hauling.

Security and distress behavior can surface activity to players without making
every encounter wait indefinitely for a witness.

### Optional estate and live-event systems

The family estate is a gated shared-corporation scenario built on existing
wormhole, structure, economy, wallet, and Living Universe services. Restoration
materials are commissioned from regional stock and delivered by outside NPC
haulers; they are not credited at order time.

Live events use their own deadline queue and bounded scheduler. The event
framework and individual content remain independently gated so unfinished
content does not activate merely because the patch is installed.

### X-Eve economic circuit

X-Eve is an experimental, disabled-by-default layer for durable economic events,
balanced ledger entries, replay-safe effects, and adaptive admission. It runs
outside the 100 ms space tick. At higher rolling latency it defers planning,
then limits work to due continuations, and finally sheds background work while
preserving queues for later recovery.

## Persistence and recovery

Long-lived tasks use durable identities and monotonic counters. External effects
such as stock movement, wallet escrow, delivery, refund, and loss settlement are
recorded so replay after interruption does not perform the same effect twice.

Recovery favors a visible terminal or quarantined state over silent guessing.
Resets are refused while unresolved deliveries or economic work would make a
reset unsafe. Runtime databases and journals are operational state and are not
part of this public patch repository.

## Performance boundary

The physical game simulation remains the source of truth for player-observed
movement and combat. Virtual state is the scalable representation for distant
activity. Small bounded schedulers bridge the two; global and per-system caps
prevent a busy Local list from automatically becoming an equally large physical
scene.

The practical target remains near the 100 ms tick baseline. See
[Performance](PERFORMANCE.md) for thresholds and capacity-test procedure.

## Distribution boundary

This architecture is delivered as changes against a separately obtained EveJS
v0.12.2 base. The repository contains no complete patched server tree, EVE
client, CCP assets, runtime databases, certificates, portrait cache, or private
deployment data.
