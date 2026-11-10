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
|`BuildMarketSeed.bat`|You want the optional standalone market|Lists all four seed types with descriptions and opens the chosen builder|
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

The seed menu offers v1 (offline synthetic prices), v2 (Tranquility snapshot),
v3 (cost-priced Jita hub plus authentic NPC stock) and v4 (Iron Man NPC stock only).
For the quickest first build, choose v1, then `Jita + New Caldari`.

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

## Real-client testing: required launch and chat checks

Use the repository-root `Play.bat` for real-client tests with a running server.
`PlayDebug.bat` runs the same checks with the client debug console enabled.
Configure the dedicated emulator client through
`tools/ClientSETUP/scripts/EvEJSConfig.bat`; preserve other clients and profiles.
Run from the repository root:

```powershell
.\Play.bat
```

An automated launch is acceptable only when it reproduces the current Play
setup and passes its gates for the same client, server and environment:

- Resolve the game and gateway endpoints, client executable and working
  directory, local `ResFiles` cache and both resource indexes.
- Verify the supported client compatibility and loopback network patches.
- Pass the certificate gate: the installation's constrained CA, current server
  leaves, Windows CurrentUser trust and native client CA bundles must agree.
  Setting proxy or CA environment variables alone does not establish this.
- Apply Play's local proxy, resource-server, Sentry and offline preference
  settings, and pass its game-server and HTTP/trusted-HTTPS offline health gates.

See [OFFLINE.md](OFFLINE.md) for the authoritative controls and repair procedure.
The firewall blocks remain recommended; they are not a required launch gate.

**Working SSL/TLS and chat are prerequisites for real-client acceptance.** The
"Error connecting to chat server" / `RetryChatServerConnection` popup is a
connection/setup failure. Do not dismiss it, answer No, disable chat, bypass TLS
verification or suppress the error to make a test pass. Stop the run, retain the
failure and fix the endpoint, listener, certificate or authentication problem
before rerunning. A passed certificate check alone does not prove chat works.

The supported build-3396210 native XMPP connection defaults to port **5222**.
Check the actual client host/port against the intended server listener.
Gridcheck's allocated XMPP port and server-side port patch do not by themselves
change the native client's destination. Do not connect a disposable test client
to another session's chat server to work around a port conflict.

The updated local Gridcheck `clientLaunch` path runs `Play.bat` with
`EVEJS_DRY_RUN=1` before minting a login token or spawning the game. The checked
client, resource cache and endpoints must match the launch; failed preflight
output is retained in `_local/gridcheck/client/play-preflight.log`.
Older Gridcheck copies do not run these gates and must be updated before use.

For this machine's managed native tests, `gridcheck.config.json` sets
`"mode": "managed"` and `"nativeClient": true`, with the dedicated
`_local/gridcheckStore` store. Native mode keeps the game/gateway port block and
reserves shared HTTPS **443** and XMPP **5222**. Startup refuses occupied ports.
The launcher CA setting is blank so Play resolves the current data-root CA.
No certificate rotation or shared-client graphics/profile changes are needed.
Gridcheck waits for native chat login/connection before reporting launch success;
`--wait 0` explicitly starts without claiming readiness.

After login, require a connected native `XmppChat` service, successful chat
authentication/channel join, and no chat retry popup; retain client/server logs
and a visible UI capture. Record the executable/build, profile, resource cache,
CA identity and game/gateway/XMPP endpoints with the run. Successful game login,
native RPC calls or a UI object alone do not establish chat or rendered UI
acceptance. The offline client oracle remains a separate, partially stubbed test.

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
