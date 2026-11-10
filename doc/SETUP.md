# EVE.js setup and operations

This guide covers first-time setup, daily operation, configuration, maintenance,
and upgrades. Run commands from the repository root unless a section says
otherwise.

[Back to the project overview](../README.md).

## Localhost only

> **EVE.js is a localhost-only project. Run the server and EVE client on the same computer.** It is not hardened for a LAN, the public Internet, port forwarding, shared hosting, or untrusted users.

The supported address is `127.0.0.1`. The Docker configuration publishes every required port specifically on `127.0.0.1`, and native listener defaults are also loopback-only. Do not remove the `127.0.0.1:` prefixes from `compose.yaml`, change bind settings to `0.0.0.0` on the host, or forward these ports through your router.

## Recommended setup: Docker

Docker is the easiest backend setup. It builds a Linux image containing:

- the Node.js game server;
- the Rust market daemon and all four seed types: synthetic, Tranquility snapshot, cost-priced Jita and Iron Man;
- automatic first-run static game-data initialization;
- persistent game and market SQLite databases.

The Windows EVE client still runs directly on your computer; it does not run inside the Linux container.

### Requirements

- Windows with Docker Desktop in **Linux containers** mode;
- a full copied EVE shared cache for build `3396210` (the copy must include `EVE\tq`, `ResFiles`, and `index_tranquility.txt`);
- free local ports `443`, `5222`, `26000`–`26002`, `26400`, `40110`, and `40111`;
- Internet access on the first start for image dependencies and the approximately 80 MB EVE SDE download.

Use a copied EVE installation. Do not patch the same installation you use for normal live play.

### Configuration used by Docker

A fresh checkout or release already contains the complete `config/` directory. Compose bind-mounts that host directory at `/app/config`, so the container and Config Editor use the same files and configuration changes survive image rebuilds. Server startup creates any missing domain files, adds newly introduced defaults without overwriting saved values, and rejects unknown or invalid settings.

The shipped settings work without a `.env` file. To customize Docker-published ports or the browser-companion token, copy the example first and edit `.env`:

```powershell
Copy-Item .env.example .env
```

Use `config/*.json` for server, gameplay, world, mining, NPC, and economy behavior. Use `.env` only for Docker deployment values described in `.env.example`; supported `EVEJS_*` values passed by Compose override the corresponding JSON setting. Check the resolved mount, ports, and environment before building or starting:

```powershell
docker compose config --quiet
```

Editing an ordinary JSON setting requires only `docker compose restart server`. Changing a published port in `.env` requires `docker compose up --detach --force-recreate server` so Docker recreates the port mapping.

### 1. Build the Linux image

Open PowerShell in this project folder and confirm Docker is using Linux containers:

```powershell
docker info --format '{{.OSType}}'
```

It should print `linux`. Build the shared local image:

```powershell
docker compose build init
```

The equivalent image-only build command is:

```powershell
docker build --tag evejs-local .
```

### 2. Choose and build the market once

There is one Rust market daemon and four ways to populate its SQLite database. Docker never chooses or replaces a market during normal startup. List the choices:

```powershell
docker compose run --rm --no-deps market-tools engines
```

For the recommended fast, repeatable synthetic market:

```powershell
docker compose run --rm --no-deps market-tools rebuild v1 --preset jita_new_caldari
```

Alternatively, use the latest EVE Ref Tranquility station-market snapshot:

```powershell
docker compose run --rm --no-deps market-tools rebuild v2 `
  --order-filter market-scope-with-npc `
  --market-solar-system-id 30000142
```

Or seed Jita 4-4 from the game's own manufacturing cost, with the Tranquility NPC catalog underneath it:

```powershell
docker compose run --rm --no-deps market-tools rebuild v3
```

Or start an Iron Man run with only authentic NPC stock and buybacks (BPOs, skillbooks, command centers and trade goods):

```powershell
docker compose run --rm --no-deps market-tools rebuild v4
```

The first rebuild also downloads the approximately 80 MB EVE SDE and generates the static game tables. V2, v3 and v4 additionally download the current market snapshot.

### 3. Start the backend

```powershell
docker compose up --detach
```

Follow progress with:

```powershell
docker compose logs --follow init market server
```

Press `Ctrl+C` to stop following logs; the containers keep running. The backend is ready when `docker compose ps --all` shows `market` and `server` as healthy and `init` as exited with code `0`:

```powershell
docker compose ps --all
```

### 4. Prepare the Windows client once

After the Docker server is healthy, run:

```text
SetupEveJS.bat
```

Choose the Docker option. It confirms the containers are healthy and that the certificates the container generated have landed on the host, then opens the client wizard. To run the wizard directly instead:

```text
tools\ClientSETUP\StartClientSetup.bat
```

Select the copied build `3396210` shared-cache folder. The wizard patches the copied client, points it at `127.0.0.1`, and trusts the same local CA that the container generated. Docker mounts the project's `_local\certs` folder as the container's certificate folder, so the host and the container share one CA and it survives container recreation.

### 5. Play

Keep the Docker backend running, then launch the client on Windows:

```text
Play.bat
```

### Daily Docker use

```powershell
# Start or resume the backend
docker compose up --detach

# Check health
docker compose ps

# Follow server and market logs
docker compose logs --follow server market

# Stop the backend but keep all data
docker compose down
```

After pulling project updates, rebuild without resetting data:

```powershell
docker compose up --build --detach
```

Normal startup preserves both databases. The initializer only creates missing static game data; market creation and replacement happen exclusively through the explicit `market-tools rebuild` commands below because the market database also contains player orders and history.

### Market seed engines and maintenance

V1, v2, v3 and v4 are seed types for the same Rust market daemon. All four produce `market.sqlite`.

| Engine | Source | Best use |
|---|---|---|
| `v1` | Deterministic synthetic prices and quantities from local static data | Fast, repeatable local worlds |
| `v2` | Latest EVE Ref Tranquility station-order snapshot | TQ-like station liquidity and NPC stock |
| `v3` | Manufacturing cost computed from local static data, plus the Tranquility NPC catalog | A cost-anchored Jita trade hub with authentic NPC blueprints and skillbooks |
| `v4` | Only authentic NPC orders from the Tranquility snapshot | Iron Man runs: NPC BPOs, skillbooks and other NPC stock; players produce the rest |

V1 supports `jita_new_caldari`, `jita_only`, `new_caldari_only`, and `full_universe`. List them with:

```powershell
docker compose run --rm --no-deps market-tools presets
```

> **Size warning:** `full_universe` can produce hundreds of millions of rows. It is not recommended for ordinary local use.

V2 supports `all-station`, `npc-only`, `player-only`, `market-scope`, and `market-scope-with-npc`. It imports station orders only; player-structure orders are excluded. Inspect the currently published source snapshot without rebuilding:

```powershell
docker compose run --rm --no-deps market-tools snapshot-info
```

V2 reuses the current matching snapshot from the persistent download cache by default. Add `--fresh-download` to a v2 rebuild command to ignore that cache and download the snapshot again.

V4 reuses the v2 importer and cache with a strict Iron Man filter: NPC orders only,
at original stations, prices and quantities, including NPC buybacks. Custom-station
stock is disabled. Run `docker compose run --rm --no-deps market-tools rebuild v4`
with `server` and `market` stopped. Add `--fresh-download` to fetch the snapshot again.

V3 is new. It prices Jita 4-4 from the game's own manufacturing cost — each type costed bottom-up through its blueprint tree, then asked at 3x that cost and bid at 1x — and lays the Tranquility NPC catalog underneath it: T1 blueprint originals, skillbooks, planetary command centers, and the trade goods NPCs buy back, at the stations, prices, and volumes TQ itself uses. Its prices come from a manifest committed to this repository, so every deployment seeds identical economics and a build is deterministic and offline once the snapshot is cached. V3 takes no preset or order filter; `rebuild v3` is the whole command. Add `--skip-overlay` to build the Jita seed without the NPC catalog, or `--fresh-download` to ignore the cached snapshot.

A money-pump audit gates a v3 rebuild. If any loop would let a player turn seed-bought goods back into more ISK than they cost, the candidate is not installed and the live market database is left exactly as it was. See [the v3 seeder guide](../tools/market-seederv3/README.md) for the detail and [Readme](../tools/market-seederv3/README.md) for the design.

#### Rebuild an existing market

> **Destructive operation:** a market rebuild replaces seeded liquidity, player orders, order events, consumed stock, and market history. The tool automatically retains a timestamped backup of the previous valid database, but you should still treat this as maintenance and log players out first.

Stop both runtime services, run exactly one rebuild, then start them again:

```powershell
docker compose stop server market

# Synthetic v1 example
docker compose run --rm --no-deps market-tools rebuild v1 --preset jita_only

# OR snapshot-based v2 example
docker compose run --rm --no-deps market-tools rebuild v2 `
  --order-filter market-scope-with-npc `
  --market-solar-system-id 30000142

# OR cost-priced Jita v3 example
docker compose run --rm --no-deps market-tools rebuild v3

docker compose up --detach market server
```

The market daemon and rebuild command use a volume lock. A rebuild refuses to run while the market container still has the database open. Candidates are built and validated separately, the existing database is backed up, and only then is the candidate installed. A v3 rebuild adds its money-pump audit to that sequence, between the build and the validation, and stops there when the audit fails.

#### Inspect, back up, and restore the market

```powershell
# Manifest, row counts, SQLite validation, and backup count
docker compose run --rm --no-deps market-tools status

# Full Rust daemon validation; stop server and market first
docker compose stop server market
docker compose run --rm --no-deps market-tools doctor

# Create a named backup while they remain stopped
docker compose run --rm --no-deps market-tools backup before-experiment

# List retained backups
docker compose run --rm --no-deps market-tools backups

# Restore the newest backup, then restart
docker compose run --rm --no-deps market-tools restore latest
docker compose up --detach market server

# Show every market-tools command
docker compose run --rm --no-deps market-tools help
```

Backups live under `/var/lib/evejs/market/backups` in the persistent `evejs-data` volume.

Runtime market inspection is also available while the backend is running:

```powershell
curl.exe http://127.0.0.1:40110/health
curl.exe http://127.0.0.1:40110/v1/manifest
curl.exe http://127.0.0.1:40110/v1/diagnostics
```

The `/v1/` URL is the HTTP API version; it is unrelated to the v1/v2/v3 seed-engine choice.

### Docker command reference

| Task | Command |
|---|---|
| Build the image | `docker compose build init` |
| Start everything | `docker compose up --detach` |
| Show all service states | `docker compose ps --all` |
| Follow runtime logs | `docker compose logs --follow server market` |
| Restart Node only | `docker compose restart server` |
| Stop runtime services | `docker compose stop server market` |
| Stop containers but retain data | `docker compose down` |
| Open a shell in Node | `docker compose exec server sh` |

### Content packs

Every release ships its content packs in a folder called `content-packs` inside
the installation, and **the server installs whatever is in there when it
starts**. There is nothing to run: set up, start the server, and the optional
content is in.

To run without a pack, delete its file from that folder and start the server
again. That is the only control, and it works the same way on native and Docker.
Deleting a file only deactivates the pack — the copy in your game store is kept,
so putting the file back switches it on again without another download.

The server says what it did, for example:

```text
[ContentPacks] installed 9 content pack(s): evejs.booster-production@1.0.0, ...
```

Packs are read once, at startup, so a change needs a restart. If the folder holds
two versions of the same pack the newer one wins and the log names the older file
as safe to delete.

Installed packs live with the persistent game store, so upgrades and container
replacement retain them. `.\ContentPacks.bat status` or
`docker compose run --rm --no-deps content-tools status` inspects the active set,
and the command line can still install and remove by hand — useful on a headless
host, though the folder wins again on the next start. See
[Installing and removing content packs](CONTENT_PACKS.md) for the
complete native and Docker procedures. The
[content-pack tool guide](../tools/ContentPacks/README.md) contains the compact CLI
reference.

### Reset all player missions

Run `tools\Maintenance\ResetMissions.bat`. It detects whether the live game
database is Docker-backed or native, asks for an explicit confirmation, and resets
mission state for every character. In Docker mode it stops the game-server container
for the offline write and restarts it afterward if it was running. In native mode,
close the game-server window before running it.

The reset clears offered and accepted missions, mission history, decline timers,
career-agent completion, Storyline progress, and Epic Arc progress. It does not delete
characters, items, wallets, standings, or mission rewards already received.

For unattended maintenance, the same launcher accepts `-Yes`. Use
`-Deployment Docker` or `-Deployment Native` only when you need to override its safe
auto-detection, and `-NoRestart` to leave a previously running Docker server stopped.

### Compact the game database

`_local\gameStore\gamestore.sqlite` never shrinks on its own: SQLite keeps the space
that deleted and rewritten rows leave behind, and over time most of the file can be
free space. To give it back, stop the server and run:

```text
node tools\Maintenance\vacuum-gamestore.js
```

It takes the store's exclusive maintenance lease first, so it refuses while the server
or another tool is using the store, and it prints the size before and after.
`--dry-run` only reports the size and how much of it is free; it changes nothing and is
safe while the server runs. `--store-root <folder>` points it at another gameStore
folder. A 796 MB development store came down to 37 MB this way.

The tool is not in the Docker image yet, so Docker installs cannot run it.

### Changing server configuration

Server configuration lives in the repository-root `config/` directory. EvEJS 261108.1 config schema 1 exposes 172 active settings, divided by purpose so you can find and review them without editing one generated megafile:

| File | Settings | Contents |
|---|---:|---|
| `config/version.json` | — | EvEJS release and config-schema versions; managed by EvEJS, not a gameplay setting |
| `config/server.json` | 35 | Development login, logging, listeners, sockets, presence, proxy, and service endpoints |
| `config/gameplay.json` | 14 | Characters, skills, subscriptions, structures, missions, and login rewards |
| `config/world.json` | 22 | Abyssal space, wormholes, system loading, simulation, and scenery |
| `config/mining.json` | 56 | Mining mechanics, resource sites, NPC mining fleets, compression, and ledgers |
| `config/npc.json` | 27 | Belt rats, authored NPCs, CONCORD, and Crimewatch |
| `config/economy.json` | 18 | Industry, market-daemon client, HyperNet, and New Eden Store settings |

The files use standard JSON with nested sections; comments and trailing commas are not valid. Unknown settings, invalid types, and out-of-range values stop startup with the exact file and property path instead of being silently ignored. On first run, all seven files are seeded with suitable defaults; later releases add newly introduced settings without overwriting values you already saved. Existing `evejs.config.json` or `evejs.config.local.json` files are accepted only as one-time migration inputs and are archived under `_local/config-backups/` after a successful migration.

#### Using the Config Editor

On Windows, launch the graphical editor from the repository root:

```powershell
.\tools\ConfigEditor\OpenServerConfig.bat
```

The launcher detects whether the live game database is native or Docker-backed. If Docker Desktop is installed but its engine is unavailable, the editor deliberately refuses to fall back to a possibly stale native database; start Docker or explicitly set `EVEJS_GAMESTORE_DATA_DIR` and `EVEJS_GAMESTORE_SQLITE_PATH` to the native `_local\gameStore` paths.

Its six configuration tabs—Server, Gameplay, World, Mining, NPC, and Economy—are generated from the same schema used by the server. The editor shows all 172 settings, their descriptions, owning JSON paths, validation rules, persisted values, and any effective environment overrides. Saving goes through the central config manager, so the same validation applies to hand-edited files, environment values, first-run defaults, and editor changes. `config/version.json` is displayed as read-only version metadata.

For a non-graphical schema/config diagnostic, run:

```powershell
node .\tools\ConfigEditor\config-manager-cli.js export
```

For ordinary Docker-side setting changes, restart the server container after saving:

```powershell
docker compose restart server
```

The `config/` directory is mounted into the container, so an image rebuild is no longer required. If you change a published Docker port, edit the matching value in `.env` and recreate the container with `docker compose up --detach --force-recreate server`; a restart cannot change an existing port publication.

Configuration precedence is:

```text
schema defaults < config/<domain>.json < supported EVEJS_* environment variables
```

Compose intentionally overrides container-only plumbing such as bind hosts, the market daemon address, and the persistent data path. Its configurable public ports come from `.env` (`EVEJS_SERVER_PORT`, `EVEJS_IMAGE_SERVER_PORT`, `EVEJS_MICROSERVICES_PORT`, and `EVEJS_REDSHIFT_MONITOR_PORT`). Their shipped defaults mirror `config/server.json`; keep the two aligned when changing Docker ports. XMPP remains fixed at the packaged client's protocol port, `5222`. Host publications remain bound to `127.0.0.1`.

The development-friendly behavior from earlier releases remains enabled by default: automatic account creation and password bypass, fake-cash purchasing, and HyperNet development grants/seeding are all available on a fresh local server. Treat those defaults as local-development defaults; review them before exposing a modified deployment beyond loopback.

Rust market runtime and seeder tuning are separate from the Node JSON configuration. Routine seed selection belongs in the `market-tools rebuild` arguments; advanced defaults live in `docker/market-server.toml`, `docker/market-seed.toml`, `docker/market-seed-v2.toml`, and `docker/market-seed-v3.toml` and require an image rebuild.

### Docker persistence

Both SQLite databases, retained market backups, downloaded snapshots, generated static data, and uploaded character portraits and alliance logos live in the named volume `evejs-data`. Server log files and Node diagnostic reports live in the separate named volume `evejs-logs`. Normal `stop`, `down`, image rebuild, and container replacement operations preserve both volumes. See [Upgrading and moving your server](#upgrading-and-moving-your-server) for the steps to carry them to a new version, folder, or PC.

> **Data-loss warning:** `docker compose down --volumes` deletes the entire Docker world state, including accounts, characters, inventory, and market state. Use it only when you intentionally want a completely fresh server.

Docker data is separate from the native `_local\gameStore` and `externalservices\market-server\data\generated` paths. Existing native state is not imported automatically.

> **Upgrading from a version whose `compose.yaml` bind-mounted `./_local/gameStore`:** on those versions the live game store was the `_local/gameStore` folder in the install directory, not the volume. Before starting this version, import that folder into the volume once (from the old install folder, with everything stopped):
>
> ```
> docker run --rm -v evejs-data:/data -v "${PWD}/_local/gameStore:/src" alpine sh -c "mkdir -p /data/gameStore && find /data/gameStore -mindepth 1 -delete && cp -a /src/. /data/gameStore/ && chown -R 1000:1000 /data/gameStore"
> ```
>
> Skip this on fresh installs, or if your `_local/gameStore` has no `gamestore.sqlite`.

### Default local ports

| Local address | Purpose |
|---|---|
| `127.0.0.1:26000` | Main game TCP server |
| `127.0.0.1:26001` | Image server |
| `127.0.0.1:26002` | Local HTTP proxy and gateway |
| `127.0.0.1:443` | Local HTTPS assets used by the client |
| `127.0.0.1:5222` | XMPP chat |
| `127.0.0.1:26400` | Redshift monitor endpoint |
| `127.0.0.1:40110` | Rust market health and diagnostics |
| `127.0.0.1:40111` | Rust market RPC |

The containerised server reaches the market over the compose network, so it does
not need either published port. `40111` is published for the case where the game
server runs on the host against a market running in Docker: point the host
server at `127.0.0.1:40111` (the `marketDaemonHost`/`marketDaemonPort` defaults).
Only one server may use the market database at a time — the market holds an
exclusive lock — so do not run the containerised `server` service and a host
server together.

## Browser companion

The browser client in the sibling repo `evejs-web-poc` talks to the `/_evejs-web/v1`
gateway on port `26002`. It runs natively or in Docker, independently of how this server
runs, and every combination works — but two of the four need one setting here.

**You do not have to do any of this by hand.** Start this server however you normally do,
then run `SetupWebClient.bat` in the `evejs-web-poc` folder. It detects how this server is
running, writes the shared secret into `.env` in *both* folders, and starts the client. The
rest of this section is what that script does, and what to change if you would rather do it
yourself.

### The gateway is loopback-only unless you give it a token

The gateway authorizes a token-less caller **only when the peer's socket address is
`127.0.0.1` or `::1`** (`authorizeGatewayRequest` in
`server/src/_secondary/express/evejsWebGateway.js`). That is the address this server
observes on the socket, not the address the caller dialled — and Docker rewrites it:

| Direction | Address this server sees | Token-less? |
|---|---|---|
| host process → native server | `127.0.0.1` | yes |
| host process → published port of the `server` container | `172.x.0.1` (bridge gateway) | **no** |
| another container → the `server` container | `172.x.0.3` (peer container) | **no** |
| container → native server via `host.docker.internal` | `127.0.0.1` (Docker Desktop) | yes |

So moving this server into Docker breaks a companion that was working a minute ago, on the
same `http://127.0.0.1:26002/...` URL, with the port published and the container healthy.
The gateway simply answers `401`.

Set a shared secret. Copy `.env.example` to `.env` in this folder and fill it in, then use
the **same** value in `evejs-web-poc/.env`:

```powershell
Copy-Item .env.example .env
powershell -Command "[Convert]::ToBase64String((1..32|%{Get-Random -Max 256}))"
```

`compose.yaml` passes `EVEJS_WEB_GATEWAY_TOKEN` into the `server` container; a native run
picks it up from the process environment. Leaving it empty is safe and keeps the gateway
loopback-only, which is correct when nothing outside this machine's loopback talks to it.

This does **not** relax the localhost-only rule at the top of this file. The token is what
lets a *local* container reach the gateway now that its peer address is no longer loopback;
the published ports stay bound to `127.0.0.1`.

### Reaching this server from a container

`compose.yaml` names its network `evejs-net` and gives the `server` service the alias
`evejs-server`, so a sibling compose project can attach to that same bridge and reach
`http://evejs-server:26002/_evejs-web/v1` directly. Container-to-container traffic never
touches a published host port. `evejs-web-poc/compose.evejs-docker.yaml` does exactly this
and joins `evejs-net` as an **external** network — this project owns it, so bring this one
up first.

The companion also reads static gameStore tables and the SDE off disk for type, station and
system names. In Docker those live in the `evejs-data` volume, which the companion mounts
read-only; see that repo's README for the details.

## Native Windows setup

Use this path only if you do not want Docker. It requires more host tooling and more separate steps.

### Requirements

- Node.js 24 LTS;
- the full copied EVE build `3396210` shared cache;
- Internet access for npm, the SDE, Rust, and build-tool downloads;
- administrator permission for certificate installation and native build tools.

Install Node.js 24 LTS from [nodejs.org](https://nodejs.org/) if it is not
already available on the machine.

### First-time setup

Run one launcher:

```text
SetupEveJS.bat
```

It installs the packages, generates the certificates, builds the local database, offers the optional market, and finally opens the client wizard — in that order, because the order matters. Re-run it any time: every step checks what is already done and only fills in what is missing. `SetupEveJS.bat -Status` reports where you are without changing anything.

Allow any Windows permission prompts during certificate installation or client
patching. Setup also offers the two recommended Windows Firewall blocks for the
client, with one administrator prompt; saying no is fine, and Play then warns
and starts. The client wizard warns if the selected EVE build is older or newer
than the supported build.

To prepare a server without configuring a client, run:

```text
SetupEveJS.bat -SkipClient
```

The Rust installer (offered by the optional market step) may install the MSVC Rust toolchain, Visual Studio C++ Build Tools, and a Windows SDK. Native server listeners default to `127.0.0.1`; keep all bind-host settings on loopback.

<details>
<summary>The individual launchers, if you prefer to run them yourself</summary>

```powershell
npm ci
npm --prefix server ci
```

1. `tools\ClientSETUP\StartClientSetup.bat`
2. `tools\DatabaseCreator\CreateDatabase.bat`
3. `tools\InstallRustForMarket.bat`
4. `BuildMarketSeed.bat` — choose a seed type; for a quick starter market, choose **v1**, then **Jita + New Caldari**
5. `StartMarketServer.bat` — choose the release-server option
6. `StartServer.bat` — choose **Server + Play**

</details>

### Daily native use

1. Run `StartMarketServer.bat` and leave it open.
2. Run `StartServer.bat` and choose **Server + Play**.
3. Use `Play.bat` when the backend is already running.

Choose **Server only** in `StartServer.bat` when you do not want to launch the
client.

To rebuild only the native game database:

```text
tools\DatabaseCreator\CreateDatabase.bat /force
```

Market reseeding replaces the market SQLite database, including live player market state. Back it up before deliberately reseeding.

## Upgrading and moving your server

Everything your server remembers — accounts, characters, ships, wallets, uploaded portraits, and market state — is kept separately from the program files. Upgrading is therefore always the same idea: **replace the program files, keep the data.** You never need to rebuild the game database to install a new version.

This section covers where that data lives and how to move a server to another
PC. For the upgrade itself — with the updater or by hand — see
[Updating EvEJS](UPDATING.md).

### Where your data actually lives

**Docker** keeps world state in the named volume `evejs-data` and post-mortem server diagnostics in `evejs-logs`. Volumes are found by name, not by folder, so you can move or replace the install folder freely and retain both the world and its recent diagnostic history.

| Volume path | What it holds |
|---|---|
| `evejs-data:/var/lib/evejs/gameStore/` | game database, characters, and uploaded portraits and alliance logos |
| `evejs-data:/var/lib/evejs/market/` | market database and its retained backups |
| `evejs-data:/var/lib/evejs/sde/` and `/var/lib/evejs/downloads/` | static data and cached downloads |
| `evejs-logs:/` | `server.log`, process-lifecycle/TiDi logs, captures, and Node diagnostic reports |

Server settings are deliberately host files rather than world state. Carry the
`config/` directory too, plus `.env` when you customized Docker ports or the web
gateway token.

**Native Windows** keeps everything inside the install folder. These are the parts to carry forward:

| In the install folder | What it holds |
|---|---|
| `_local\gameStore\` | game database, characters, and uploaded portraits and alliance logos |
| `externalservices\market-server\data\generated\` | market database |
| `config\` | your versioned server settings |

> **Upgrading from a version released before 25 July 2026:** uploaded character portraits used to be written into the program files, at `server\src\_secondary\image\generated\Character`. That is why they were left behind whenever an install was copied to a new folder, and why rebuilding a Docker container erased them. They now live in `_local\gameStore\images`, beside the game database, so they travel with everything else. The server keeps reading the old location in the meantime, so nothing breaks if you upgrade first and migrate later; [Older installations](UPDATING.md#older-installations) has the one-time copy that brings old portraits across.

### Doing the upgrade

**The short way, and the one to recommend:** run `UpdateEveJS.bat`, pick the
release zip, and it replaces the program files in place — native or Docker —
keeping your world, settings, certificates and launcher configuration, and moving
the old program files to `_backup` rather than deleting them. Installations older
than the tool can be handed `EvEJS-Updater.zip`, which runs from anywhere.

**By hand** still works and is the documented fallback: unpack the new version
into a new folder and bring your data across. It is what to use for a non-Windows
Docker host, or when you want the old installation left exactly as it is.

Both paths, the full manual steps for native and Docker, and the one-time
migrations for older installations are in
**[Updating EvEJS](UPDATING.md)**.

### Moving a server to another PC

**Docker.** Stop the server with `docker compose down`, then pack the world and
diagnostic volumes into files:

```
docker run --rm -v evejs-data:/data -v "${PWD}:/backup" alpine tar czf /backup/evejs-data.tar.gz -C /data .
docker run --rm -v evejs-logs:/logs -v "${PWD}:/backup" alpine tar czf /backup/evejs-logs.tar.gz -C /logs .
```

Copy both archives, `config/`, and any customized `.env` to the new PC,
install the same EVE.js version there, and unpack the volumes before the first start:

```
docker run --rm -v evejs-data:/data -v "${PWD}:/backup" alpine sh -c "cd /data && tar xzf /backup/evejs-data.tar.gz && chown -R 1000:1000 /data"
docker run --rm -v evejs-logs:/logs -v "${PWD}:/backup" alpine sh -c "cd /logs && tar xzf /backup/evejs-logs.tar.gz && chown -R 1000:1000 /logs"
```

The same two commands make a complete backup and restore on one PC.

**Native Windows.** Copy the whole install folder to the new PC, then rerun the client setup wizard there so the new machine trusts the local certificates.

## Troubleshooting

- `docker compose ps` — check container and health status.
- `docker compose logs --tail 200 init market server` — inspect recent startup failures.
- `docker compose cp server:/var/lib/evejs/logs ./evejs-server-logs` — copy the persistent application logs and Node reports into a normal host folder for incident review.
- `curl.exe http://127.0.0.1:26002/health` — check the Node HTTP side.
- `curl.exe http://127.0.0.1:40110/health` — check the Rust market.
- If Docker cannot publish port `443`, stop the other local program using it before starting EVE.js.
- If the market database is missing, run `docker compose run --rm --no-deps market-tools status`, then choose an explicit v1, v2, v3 or v4 rebuild command above.
- If a v3 rebuild stops on its money-pump audit, the live market database was not replaced; read the reported loops before changing any pricing and rebuilding.
- If a rebuild says the market is in use, run `docker compose stop server market` and retry it.
- If the client rejects local TLS, rerun the client setup wizard while the Docker backend is healthy so it installs the persisted Docker CA.

## Related documentation

- [Launcher guide](LAUNCHERS.md)
- [Installing and removing content packs](CONTENT_PACKS.md)
- [Market setup](MARKET_SETUP.md)
- [Market seeder guide](MARKET_SEEDER.md)
- [Jita index seeder, v3](../tools/market-seederv3/README.md)
- [Iron Man NPC-only seeder, v4](../tools/market-seederv4/README.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Tools and admin basics](TOOLS.md)
