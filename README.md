# X-Eve Living Universe

X-Eve Living Universe is an independent source patch for a compatible v0.12.2
server baseline. It adds a persistent virtual NPC population, regional
economic activity, materialized traffic around players, conflict, industry,
logistics, and supporting performance controls.

> This is a patch-only repository, not a runnable server distribution.
> It contains neither the compatible server baseline nor an EVE client, CCP assets,
> databases, certificates, generated portraits, or private server
> configuration. Obtain a compatible base independently and apply the patch to
> your own clean copy.

The patch is pre-release software. Back up any installation and world data
before trying it.

## Compatibility

The current patch targets one exact **v0.12.2 compatible server baseline**. The
independently obtained archive used to build and verify this release has this
SHA-256:

```text
7EC99325F6555F1C9C3C9CC3E45FD2225FE4F2805DA9DDBD827E850BBAA5F1F8
```

Check an archive in PowerShell with:

```powershell
Get-FileHash -Algorithm SHA256 'C:\path\to\server-v0.12.2.zip'
```

Do not apply the patch to another server version, an already modified tree, or
your only working copy. The installer validates the expected v0.12.2 baseline
before changing anything and stops on a mismatch.

## Install

You need Git for Windows and PowerShell. Stop the server and its supporting services,
extract a clean v0.12.2 base, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\Install-XEvePatch.ps1 `
  -EveJSPath 'C:\path\to\server-v0.12.2'
```

The installer applies the single versioned patch, verifies the result, and
rolls back automatically if an installation step fails. The batch-file wrapper
is equivalent:

```bat
installer\Install.bat "C:\path\to\server-v0.12.2"
```

Verify the installation separately with:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\Verify-XEvePatch.ps1 `
  -EveJSPath 'C:\path\to\server-v0.12.2'
```

See [Installation](docs/INSTALL.md) for backup, verification, test, and
uninstall details.

## Enable deliberately

The major simulation systems are **disabled by default**. Installing the patch
does not silently populate a universe or reset an economy. Start with a small
test configuration and opt in through the target server's private configuration
file or corresponding environment variables.

The normal performance reference is a **100 ms** tick interval. Treat **120 ms
p95** as a warning and **130 ms p95** as a load-test ceiling, not a normal
playing target. The optional **10x off-grid travel multiplier is for testing
only**: it accelerates unobserved virtual travel while observed and materialized
ships continue using normal movement timing.

See [Configuration](docs/CONFIGURATION.md) and
[Performance](docs/PERFORMANCE.md) before increasing population or physical NPC
budgets.

## What the patch adds

- Persistent NPC pilots with affiliations, roles, racial doctrines, loadouts,
  local presence, and portrait support.
- Deadline-driven virtual travel across the universe, with ships materialized
  only where players can observe them.
- Mining, freight, procurement, regional stock, manufacturing, and market flows
  designed around conserved inputs and completed deliveries.
- Witnessable combat, pirate activity, security responses, losses, and the
  resulting replacement demand.
- Bounded schedulers, physical-ship caps, durable state, economy telemetry, and
  performance admission controls.
- Optional estate, wormhole, live-event, and X-Eve experimental systems behind
  explicit feature gates.

Read [Architecture](docs/ARCHITECTURE.md) for the simulation model.

## Repository contents

- `patches/v0.12.2/x-eve-living-universe-v0.1.0-pre1.patch` - the single
  versioned source patch.
- `installer/` - baseline validation, installation, verification, rollback, and
  uninstall helpers.
- `docs/` - public installation, configuration, architecture, and performance
  notes.

No patched server tree is stored here. Runtime data and private deployment
details do not belong in this repository.

## Project and trademark notice

This project is independent and is not affiliated with, endorsed by, or
sponsored by CCP Games or any upstream server project. EVE Online and all
related names, logos, marks, and game assets are the property of their
respective owners; EVE-related trademarks belong to CCP Games. No CCP client,
assets, or server baseline are redistributed here.

The license in [LICENSE](LICENSE) applies only to original contributions in
this patch repository. It does not grant rights to any compatible server
baseline, EVE Online, or other third-party material.
