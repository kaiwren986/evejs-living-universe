# EVE.js RPG with the Living Universe

A fork of EVE.js, the local EVE Online server emulator ([project Discord](https://discord.gg/KMuJrMDEBa)),
that turns a single-player EVE universe into an RPG. Two things are added on top of stock EVE.js:

- **The Living Universe**: 5,000 persistent NPC pilots with names, faces, employers, jobs and ships,
  who fly, haul, mine and police the universe whether or not you are watching.
- **An RPG layer**: story contracts, contacts who remember you, and a local language model that
  gives the people of that universe a voice. Everything is in the game's own windows; there is no
  browser UI and nothing to type.

It targets **EVE 24.01 build 3396210** and EVE.js release **261108.1**. You need your own copy of
that client; no game files are in this repository. This project is not affiliated with CCP Games.

> **Status: work in progress.** This is a personal project under active development. The parts
> listed under "Working" have been played in the client. The parts under "Ported, still being
> play-tested" pass their automated checks but have had little or no time in the client yet.

## What is in it

### Working

- **Crew Link**, a new in-game window with a permanent Neocom button. It is where the RPG layer
  lives: companions, contracts, contacts.
- **Generated contracts.** The server picks the facts (who, where, what, how much); the language
  model writes the briefing and the villain's taunts; a private combat site is built for you in
  space; the kill is detected and the reward is paid once. See
  [doc/RPG_CONTRACTS.md](doc/RPG_CONTRACTS.md).
- **Contacts.** The people who give you work keep a trust level that rises with finished jobs and
  falls with abandoned ones, pay better as it rises, need real time between jobs, and sometimes
  call you first.
- **Pilots in Local.** Living Universe pilots in space in your system are listed in Local, with a
  name, corporation, portrait and Show Info, and the list changes as they come and go.

### Ported, still being play-tested

- **Pilot ships in space.** The Living Universe's pilot simulation runs on the new engine: flights
  are simulated cheaply while nobody is there and become real ships when a player is in the system.
  Shooting a pilot makes you hostile to its faction, and its flight shoots back.
- **Pilot voices.** Say something in Local and a pilot there may answer; address one by name and
  that pilot answers; pilots also talk among themselves. Each pilot remembers its past exchanges
  with you.

### Not yet

- The Living Universe's **economy** (industry, hauling, market stock), **conflict** (roaming gangs,
  campaigns) and **hirelings** are in the tree but switched off until they are ported and checked.
  [doc/LIVING_UNIVERSE_PORT.md](doc/LIVING_UNIVERSE_PORT.md) has the method, what is done and what
  is left.
- Courier and freight contracts, an overall reputation, recurring villains.
- An installer that applies all of this to an existing EVE.js install.

## The Living Universe

The Living Universe began as a separate mod for EVE.js 0.12. Those releases are still in this
repository under the tags `v0.1.0` to `v0.2.2` and the `release/*` branches. From here on it is
developed as part of this fork: the RPG layer needs its pilots as the cast, so the two ship
together.

The mod's own code is kept as it was written (under `server/src/space/npc/ambientTraffic` and
`server/src/space/npc/governance`) and each change it needs in a stock EVE.js file is small and
marked with a `// Living Universe:` comment. Its settings are in `config/xeve.json`.

## The language model

The RPG layer talks through a model running on your own computer; nothing is sent to an outside
service. It expects [LM Studio](https://lmstudio.ai) serving an OpenAI-style API on
`127.0.0.1:1234`; the model and limits are set in `config/llm.json`, and
`tools/LocalAI` has the scripts that start it.

The rule throughout is **the model talks, the server decides**: rewards, sites, standings and
outcomes are computed by the server, and every line the model writes has a written fallback, so
the game plays the same with the model off, only less colourfully.

## Client mods

New windows need code inside the game client. `tools/ClientMods` installs a small loader into the
client's code archive (the original is kept and can be restored), and the loader runs the Python
files in `client-mods/mods`, reloading one when it changes on disk. That is how Crew Link, its
Neocom button and the Local chat switch get into the game.

## Running it

Set up EVE.js as described in [doc/SETUP.md](doc/SETUP.md) first. Then `PlayRPG.bat` starts
everything in one go: the local model, the market server, the game server and the client with the
mods installed.

## Branches

- `main`: this fork.
- `upstream`: unmodified EVE.js releases, one commit each. A new EVE.js release is committed there
  and merged into `main`.

## Licence

GNU Affero General Public License v3, the same as EVE.js. See [LICENSE](LICENSE).

---

The rest of this page is the stock EVE.js documentation, which still applies.

## Localhost only

> **EVE.js is a localhost-only project. Run the server and EVE client on the same computer.** It is not hardened for a LAN, the public Internet, port forwarding, shared hosting, or untrusted users.

The supported address is `127.0.0.1`. The Docker configuration publishes every required port specifically on `127.0.0.1`, and native listener defaults are also loopback-only. Do not remove the `127.0.0.1:` prefixes from `compose.yaml`, change bind settings to `0.0.0.0` on the host, or forward these ports through your router.

## Getting started

Docker is the recommended backend setup. Native Windows installation is also supported.

- [Recommended Docker setup](doc/SETUP.md#recommended-setup-docker)
- [Native Windows setup](doc/SETUP.md#native-windows-setup)
- [Browser companion setup](doc/SETUP.md#browser-companion)

## Earlier crew prototype

Before the RPG direction settled on story and contracts, this fork explored a crew-staffing
economy ("X-Command"). It is backend only and is not the current direction, but the design notes
remain:

- [Ship crews and the industrial RPG](doc/SHIP_CREW_RPG_DESIGN.md)
- [X-Command: persistent courier crew prototype](doc/CREW_SLICE.md)
- [X-Command: automated mining, refining and ammo/module manufacturing](doc/CREW_MANUFACTURING.md)
- [X-Command: surplus selling and production funding](doc/CREW_SELLING.md)
- [X-Command: sales-funded mineral buying](doc/CREW_BUYING.md)
- [X-Command: full economy loop testing and recovery](doc/CREW_ECONOMY_LOOP.md)
- [X-Command: profit-aware manufacturing and mineral buying](doc/CREW_PROFITABILITY.md)
- [X-Command: adaptive production and procurement priorities](doc/CREW_PRODUCTION_PRIORITY.md)
- [X-Command: production-directed mining and refining](doc/CREW_RESOURCE_PLANNING.md)
- [X-Command: production-directed courier deliveries](doc/CREW_COURIER_PRIORITY.md)
- [X-Command: full production-aware economy stress tests](doc/CREW_PRODUCTION_STRESS.md)
- [X-Command: crew experience and work skills](doc/CREW_PROGRESSION.md)
- [X-Command: buying and selling crew skills](doc/CREW_TRADE_PROGRESSION.md)

## Operations and maintenance

- [Docker daily use](doc/SETUP.md#daily-docker-use)
- [Market seed engines, backups, and maintenance](doc/SETUP.md#market-seed-engines-and-maintenance)
- [Content packs](doc/SETUP.md#content-packs)
- [Resetting player missions](doc/SETUP.md#reset-all-player-missions)
- [Changing server configuration](doc/SETUP.md#changing-server-configuration)
- [Docker persistence and local ports](doc/SETUP.md#docker-persistence)
- [Updating to a new release](doc/UPDATING.md)
- [Upgrading or moving a server](doc/SETUP.md#upgrading-and-moving-your-server)
- [Setup troubleshooting](doc/SETUP.md#troubleshooting)

## More documentation

- [Launcher guide](doc/LAUNCHERS.md)
- [Installing and removing content packs](doc/CONTENT_PACKS.md)
- [Market setup](doc/MARKET_SETUP.md)
- [Market seeder guide](doc/MARKET_SEEDER.md)
- [Jita index seeder, v3](tools/market-seederv3/README.md)
- [Iron Man NPC-only seeder, v4](tools/market-seederv4/README.md)
- [Troubleshooting](doc/TROUBLESHOOTING.md)
- [Tools and admin basics](doc/TOOLS.md)

Lots works; lots does not.
