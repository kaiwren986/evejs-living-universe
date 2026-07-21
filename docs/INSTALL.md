# Installation

This repository contains a source patch and its installer, not a complete EveJS
server. Obtain the compatible base independently.

## Requirements

- Windows with PowerShell 5.1 or newer.
- Git for Windows available on `PATH`.
- A clean, separately obtained JohnElysian EveJS v0.12.2 tree.
- A backup of any configuration, databases, certificates, and world state you
  intend to keep.

The installer does not download EveJS or an EVE client. It does not configure a
public server, firewall, DNS, certificates, or client connection profile.

## 1. Verify the base archive

The v0.12.2 archive used for this patch has this SHA-256:

```text
7EC99325F6555F1C9C3C9CC3E45FD2225FE4F2805DA9DDBD827E850BBAA5F1F8
```

Verify your independently obtained archive:

```powershell
Get-FileHash -Algorithm SHA256 'C:\Downloads\EveJS-v0.12.2.zip'
```

The hash must match exactly. A filename alone is not proof of compatibility.
If it differs, stop rather than forcing the patch.

## 2. Prepare a clean copy

Extract the archive to a new directory. Do not point the installer at:

- a running server;
- an installation containing unrelated source edits;
- a directory from another EveJS release;
- your only copy of important databases or configuration.

Stop the game server, market service, and related tools before installing. The
installer checks the expected v0.12.2 file hashes and the absence of patch-added
paths before it writes anything.

## 3. Apply the single patch

From the root of this patch repository, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\Install-XEvePatch.ps1 `
  -EveJSPath 'C:\Games\EveJS-v0.12.2'
```

Or use the wrapper:

```bat
installer\Install.bat "C:\Games\EveJS-v0.12.2"
```

The installer:

1. resolves and validates the target;
2. checks the exact supported baseline;
3. rejects an existing patch installation or conflicting added paths;
4. backs up modified originals under
   `_local/x-eve-patch/backups/<timestamp>` inside the target;
5. runs a dry patch check before applying anything;
6. applies the one versioned patch;
7. verifies installed-file hashes; and
8. automatically rolls back if installation fails.

The backup and install record are local operational data. Do not commit the
target's `_local` directory to a public repository.

## 4. Verify

Run the non-mutating installed-file verification:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\Verify-XEvePatch.ps1 `
  -EveJSPath 'C:\Games\EveJS-v0.12.2'
```

The wrapper form is:

```bat
installer\Verify.bat "C:\Games\EveJS-v0.12.2"
```

To include the patch's test suite after normal EveJS dependencies are
installed:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\Verify-XEvePatch.ps1 `
  -EveJSPath 'C:\Games\EveJS-v0.12.2' -RunTests
```

Or:

```bat
installer\Verify.bat "C:\Games\EveJS-v0.12.2" --run-tests
```

A file-integrity pass confirms that the expected patch is present. A test pass
also exercises the bundled server-side verification scripts; it may require the
normal EveJS dependencies and supporting services used by those tests.

## 5. Configure and start conservatively

The principal simulation gates remain off after installation. Follow
[Configuration](CONFIGURATION.md), begin with the 400-pilot profile, and keep
the off-grid travel multiplier at `1` for normal play.

Do not copy a public example over your complete private configuration. Add the
documented keys to the existing top-level object in `evejs.config.local.json`.

## Uninstall

Stop EveJS and run:

```bat
installer\Uninstall.bat "C:\Games\EveJS-v0.12.2"
```

Uninstall is deliberately conservative. If a patched file has changed since
installation, it refuses to overwrite that work. For an unchanged install it
restores backed-up originals, removes unchanged patch-added files, and removes
the local install record.

Back up world state separately. Removing source changes is not the same as
reversing database migrations or simulated economic activity produced while the
patch was running.

## Installation refusal is a safety result

Do not bypass a baseline, hash, added-path, or changed-file refusal. Extract a
fresh v0.12.2 copy, verify its archive hash, and try again. Manual partial
application makes later verification and uninstall unreliable.
