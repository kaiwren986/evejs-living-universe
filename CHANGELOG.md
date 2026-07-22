# Changelog

All notable public patch releases are recorded here.

This project uses pre-release version labels while compatibility, persistence,
and balance are still being tested.

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
