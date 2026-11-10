# Launcher Guide

This is the "what should I click?" page.

If you do not want to guess which batch file matters, use this.

## The Only Two Buttons Most People Need

* `SetupEveJS.bat`
* `StartServer.bat`

That is enough for normal setup and play. Add `UpdateEveJS.bat` when a new
release comes out.

## What Each Launcher Does

|Click this|Use it when|What it does|
|-|-|-|
|`SetupEveJS.bat`|First-time setup, or after an update|Runs every setup step in the right order and skips whatever is already done. `-Status` shows progress without changing anything|
|`tools\\\\\\\\ClientSETUP\\\\\\\\StartClientSetup.bat`|You only want to redo the client|Walks you through client setup, certificate install, patching, and local-server config|
|`UpdateEveJS.bat`|A new release came out|Opens a window. Pick the release zip and it replaces the program files while keeping your world, settings and certificates. See [UPDATING.md](UPDATING.md)|
|`StartServer.bat`|Normal daily use|Creates the local database if needed, then starts the server or starts the server and launches the client for you|
|`ProfileServer.bat`|Capture long login, jump or warp pauses|Starts the native server and both profiling captures, then automatically creates one ErrorReport ZIP; Enter finishes the capture early. See [PAUSE_PROFILING.md](PAUSE_PROFILING.md)|
|`Play.bat`|You already started the server yourself|Reads the current game/gateway endpoints from `config\server.json`, checks them, and launches only the client|
|`tools\DatabaseCreator\CreateDatabase.bat`|You want to create or rebuild local database files manually|Downloads the public EVE SDE and generates `_local\gameStore`|
|`BuildMarketSeed.bat`|You want the optional standalone market|Builds or refreshes the market database|
|`StartMarketServer.bat`|You use the optional standalone market|Starts the separate market daemon|
|`tools\\\\Maintenance\\\\ResetMissions.bat`|You want every player to start the mission system from scratch|Detects Docker or native data, confirms the destructive reset, and clears all characters' mission state|
|`tools\\\\\\\\ConfigEditor\\\\\\\\OpenServerConfig.bat`|You want to edit local config or player data|Creates the local database if needed, then opens the desktop config and database editor|
|`tools\\\\\\\\NewEdenStoreEditor\\\\\\\\StartStoreEditor.bat`|You want to edit store content|Opens the desktop New Eden Store editor|

## Best Choices By Situation

### I am brand new

Click:

```text
SetupEveJS.bat
```

Then:

```text
StartServer.bat
```

Choose `2`.

The first server start may take longer because it downloads the SDE and generates `_local\gameStore`.

### I already set everything up before

Click:

```text
StartServer.bat
```

Choose:

* `1` if you only want the server
* `2` if you want the server and client together

### I already have the server running and only want to launch the game

Click:

```text
Play.bat
```

### I want the optional fast market

Click these in order:

1. `BuildMarketSeed.bat`
2. `StartMarketServer.bat`
3. `StartServer.bat`

### I want to edit server settings or data

Click:

```text
tools\\\\\\\\ConfigEditor\\\\\\\\OpenServerConfig.bat
```

The first launch may take longer because it generates `_local\gameStore` if the local database is missing.

### I want to edit the store

Click:

```text
tools\\\\\\\\NewEdenStoreEditor\\\\\\\\StartStoreEditor.bat
```

That tool needs Python 3 installed.

## Launchers Most Players Can Ignore

You usually do not need to touch:

* `PlayDebug.bat` (runs `Play.bat` with `EVEJS_CLIENT_DEBUG=1`: the EVE client opens its own debug console window instead of writing to the client log file)
* `tools\\\\\\\\ClientCodeGrabber\\\\\\\\StartCodeGrabber.bat`

You also usually do not need to run `tools\DatabaseCreator\CreateDatabase.bat` by hand. Use it when you want to rebuild the local database with `/force`.

Those are more useful for debugging or project maintenance than normal play.

## Related Guides

* [SETUP.md](SETUP.md)
* [MARKET\_SETUP.md](MARKET_SETUP.md)
* [TOOLS.md](TOOLS.md)
* [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
