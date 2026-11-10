# Troubleshooting

This is the calm "something is being annoying" guide.

## Start Here First

Check these before doing anything fancy:

1. Did you install Node.js `LTS`?
2. Did you run `npm ci` and `npm --prefix server ci` from the repo root?
3. Did `tools\ClientSETUP\StartClientSetup.bat` finish all of its steps?
4. Are you using a copied EVE client folder?
5. Did the local database finish generating under `_local\gameStore`?
6. Is `StartServer.bat` running before the game tries to connect?

## Problem: The Setup Wizard Cannot Find My Game

Usually this means one of these happened:

- you picked the wrong folder
- you picked your live EVE install instead of a copied one
- you picked a launcher folder instead of the actual copied client folder

Best fix:

1. run `tools\ClientSETUP\StartClientSetup.bat` again
2. point it at your copied EVE folder
3. let it finish the checks again

## Problem: Play.bat Says Setup Is Still Needed

This usually means one of the required setup pieces is still missing.

Best fix:

1. run `tools\ClientSETUP\StartClientSetup.bat` again
2. let it complete every step
3. try `Play.bat` again

## Problem: The Game Opens But Will Not Log In

Check these:

1. is `StartServer.bat` still open?
2. did you start the server before launching the client?
3. did the setup wizard finish the certificate and patching steps?
4. did the local database generation finish successfully?

The easiest retry path is:

1. close the client
2. start `StartServer.bat`
3. choose `2`

## Problem: Database Generation Failed

`StartServer.bat` runs `tools\DatabaseCreator\CreateDatabase.bat` automatically when `_local\gameStore\manifest.json` is missing.

Check these:

1. Node.js `LTS` is installed and available in Terminal
2. your internet connection can download the public EVE SDE
3. the repo path is not read-only
4. there is enough free disk space for the SDE download and generated database

To retry from scratch, run:

```text
tools\DatabaseCreator\CreateDatabase.bat /force
```

## Problem: Windows Blocked A Setup Step

Try this:

1. close the wizard
2. right-click `tools\ClientSETUP\StartClientSetup.bat`
3. choose `Run as administrator`
4. run the setup again

This is most often needed for certificate-related or patch-related steps.

## Problem: The Optional Market Looks Empty

Check these in order:

1. did `BuildMarketSeed.bat` finish successfully?
2. is `StartMarketServer.bat` running?
3. did you reseed and forget to restart the market server?

If in doubt:

1. run `BuildMarketSeed.bat`
2. choose `v1 - Synthetic starter market`, then `Jita + New Caldari`
3. start `StartMarketServer.bat` again

## Problem: The Config Editor Will Not Open

Try:

1. run `tools\ConfigEditor\OpenServerConfig.bat` again
2. allow PowerShell if Windows prompts you

If it still closes instantly, keep the error window open and read the first error line.

## Problem: The Store Editor Will Not Open

`tools\NewEdenStoreEditor\StartStoreEditor.bat` needs Python 3.

If it says Python is missing:

1. install Python 3
2. run the same launcher again

## Sending The Team An Error Report

If you are stuck, or something crashed, send us a report bundle instead of
screenshots. Run:

```text
tools\ErrorReport\ErrorReport.bat
```

It asks one optional question ("describe what happened"), then packs your
most recent server logs, crash reports, settings, and version numbers into a
single zip file like `EveJS-ErrorReport_v0.12.4.1_2026-08-06_153045.zip` and
shows it to you in Explorer.

Upload that zip to the Discord bug channel with a sentence about what you were
doing. That one file usually answers every question we would have asked.

Good to know:

- it works for Docker installs too, even when the server container crashed
- it never includes certificates, keys, or your game database
- it does include your logs and settings, which contain your character names
  and folder paths — look inside the zip first if that concerns you

## The Fast Recovery Path

If you just want to get back in quickly:

1. close the client
2. run `tools\ClientSETUP\StartClientSetup.bat`
3. run `StartServer.bat`
4. choose `2`

## More Guides

- [PAUSE_PROFILING.md](PAUSE_PROFILING.md): capture multi-second login, jump and warp pauses
- [SETUP.md](SETUP.md)
- [LAUNCHERS.md](LAUNCHERS.md)
- [MARKET_SETUP.md](MARKET_SETUP.md)
- [TOOLS.md](TOOLS.md)
