# Tools And Admin Basics

This page explains the `tools/` folder in normal human language.

If you are just here to play, you only need a small part of it.

## Tools Most People Will Actually Use

### `tools\ClientSETUP`

Use this for first-time setup.

Launcher:

```text
tools\ClientSETUP\StartClientSetup.bat
```

This is the main setup wizard. It is the most important tool in the repo for normal users.

### `tools\Updater`

What `UpdateEveJS.bat` opens.

Use it when a new release comes out. Pick the release zip and your folder, and it
swaps the program files while leaving your world, settings, certificates and
launcher configuration alone. Content packs are installed by the server itself,
from the content-packs folder a release ships.

Old program files are moved into `_backup`, not deleted, so an update can be
undone.

See [UPDATING.md](UPDATING.md).

### `tools\ConfigEditor`

Use this if you want to edit local server settings or local data through a desktop window.

Launcher:

```text
tools\ConfigEditor\OpenServerConfig.bat
```

Good for:

- changing local server settings
- adjusting local data without digging through files by hand

### `tools\ErrorReport`

Use this when something breaks and you want to send the team a bug report.

Launcher:

```text
tools\ErrorReport\ErrorReport.bat
```

It gathers your most recent server logs, crash reports, settings, and version
numbers into one zip file, then shows you the file so you can upload it (for
example to the Discord bug channel). It works for both normal installs and
Docker installs, even when the server has crashed.

It never includes certificates, keys, or your game database.

### Market seed builders

Use this only if you want the optional standalone market server.

Easy launcher:

```text
BuildMarketSeed.bat
```

The root launcher describes all four seed types and opens the chosen builder:

| Seed | Tool folder | What it supplies |
|---|---|---|
| v1 | `tools\market-seed` | Offline synthetic prices, with Jita + New Caldari and wider presets |
| v2 | `tools\market-seederv2` | Real Tranquility station prices and quantities; Jita plus NPC stock by default |
| v3 | `tools\market-seederv3` | A cost-priced Jita hub plus authentic NPC stock at its original stations |
| v4 | `tools\market-seederv4` | Iron Man: only NPC BPOs, skillbooks, command centers, trade goods and buybacks |

See [MARKET_SEEDER.md](MARKET_SEEDER.md) for the individual launchers and build steps.

### `tools\NewEdenStoreEditor`

Use this if you want to edit store content.

Launcher:

```text
tools\NewEdenStoreEditor\StartStoreEditor.bat
```

This tool needs Python 3.

## Tools Most Players Can Ignore

### `tools\ClientCodeGrabber`

This is a maintainer tool, not a normal player setup tool.

It is used for refreshing client reference/code snapshots for development work.

If you are just trying to set up EvEJS and play, you do not need it.

## The Simple Rule

If you are not sure what to use:

1. use `tools\ClientSETUP\StartClientSetup.bat`
2. use `StartServer.bat`
3. ignore the rest until you actually need them

## Related Guides

- [SETUP.md](SETUP.md)
- [UPDATING.md](UPDATING.md)
- [LAUNCHERS.md](LAUNCHERS.md)
- [MARKET_SETUP.md](MARKET_SETUP.md)
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
