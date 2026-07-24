# Changelog

All notable public patch releases are recorded here.

This project uses pre-release version labels while compatibility, persistence,
and balance are still being tested.

## 0.1.0-pre2 - 2026-07-24

### Roaming conflict

- Added persistent pirate and security operation groups that stage, travel,
  patrol, camp, and disperse on jittered deadlines instead of creating every
  encounter from a global periodic scan.
- Added deterministic co-location checks so hostile groups meet only while
  sharing a system or the same directional gate lane during the same time
  window; expired catch-up contacts do not become present-day battles.
- Added witnessable gate camps and roaming contacts. Ships that are already
  materialized at a camp are adopted into combat in place rather than removed
  and respawned, and NPC combat remains neutral to a nearby player unless
  ordinary aggression rules make the player a participant.
- Added mutual conflict losses, retained civilian interdiction opportunities,
  and connected observed camp losses to replacement demand.

### Replacement logistics

- Removed the quantity-one reserve deadlock that could leave replacement hulls
  or fittings permanently requested but never delivered.
- Allowed priority replacement freight to consume the last remote source unit
  while protecting stock already staged at the requesting station.
- Made complete replacement fitting packages reserve and settle atomically so
  a partial batch cannot masquerade as a usable replacement.
- Restricted pirate-hull production to matching pirate factories and real
  mineral inputs; missing inputs now create ordinary priority procurement and
  freight work rather than a free import.
- Included the bounded NPC salvage-recovery dependency used by the current
  economy runtime, with durable job state and existing salvager reward rules.

### Capacity controls and verification

- Capped roaming conflict at 96 persistent groups, 16 due transitions and 192
  presence checks per pass, six concurrent camps, and a 1.5 ms synchronous
  work budget.
- Kept distant operations deadline-driven and virtual. Player-observed camps
  still obey the existing per-system and global materialized-ship budgets.
- Added fixed-size V8 garbage-collection telemetry and telemetry-capture build
  duration so host pauses can be separated from game-tick or roaming work
  without enabling a heavyweight profiler.
- Added focused verification for the roaming kernel, emergent contacts,
  already-visible camps, replacement delivery, priority demand, and
  mineral-backed pirate production, plus a focused GC telemetry verifier.
- Expanded the public-package audit to reject public IP addresses, email
  addresses, absolute machine paths, credential-shaped values, private keys,
  and binary diffs inside the canonical patch payload.

## 0.1.0-pre1 - 2026-07-21

Initial patch-only preview for the compatible v0.12.2 server baseline.

### Living universe

- Added persistent virtual NPC pilots distributed across regions, factions,
  corporations, and operational roles.
- Added deadline-based travel and work scheduling so distant actors advance
  without consuming a full physical ship tick.
- Added player-proximity materialization, local presence, portrait support,
  physical-ship budgets, and observed-flight behavior.
- Added regional and racial traffic doctrines, role-appropriate hull selection,
  fittings, combat effects, and governed module-drop behavior.

### Economy and conflict

- Added conserved mining, freight, procurement, stock, production, and industry
  flows with durable job and delivery state.
- Added regional route selection, competitive NPC buy orders, trade accounting,
  telemetry snapshots, and bounded stock reconciliation.
- Added witnessed and off-grid conflicts, campaigns, ship losses, distress
  incidents, and security or corporate response behavior.
- Added replacement demand so simulated loss feeds back into hauling and
  production.

### Experimental systems

- Added the disabled-by-default X-Eve scheduler and economic event circuit.
- Added optional live events, family-estate restoration, wormhole logistics, and
  starter-progression foundations behind feature gates.
- Added safe unobserved-travel acceleration for local testing while preserving
  normal timing when ships are observed or materialized.

### Performance and verification

- Added bounded background work, physical NPC caps, rolling tick telemetry,
  load shedding, recovery hysteresis, and runtime economy reporting.
- Added verification scripts for population, transit, materialization, economy,
  mining, industry, conflict, doctrines, estate logistics, and X-Eve recovery.

### Public packaging

- Repackaged the project as one versioned patch plus a validating installer.
- Excluded the server baseline, EVE client, CCP assets, databases, certificates,
  generated runtime content, and private deployment configuration.
