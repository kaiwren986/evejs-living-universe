# Content pack installation and removal

Content packs are optional, data-only additions to EVE.js, loaded once during
server startup. EVE.js does not hot-reload content packs: stop the server before
installing, updating, removing, or rolling back a pack, and then start it again.

**A release ships the official packs in its `content-packs` folder, and the
server installs them when it starts.** A new installation therefore has the
optional content without anyone downloading or running anything, and the rest of
this page is for changing that: dropping a pack you do not want, adding one that
came from somewhere else, or rolling one back. Packs remain optional — a base
installation runs correctly with none of them.

The official `evejs.ore-anomalies` pack adds the ordinary ore-anomaly dungeon
templates and their universe spawn profile. The official
`evejs.combat-anomalies` pack adds the ordinary pirate combat anomalies
(Hideaway, Burrow, Refuge, Den, Yard, Rally Point, Port, Hub, Haven, Sanctum and
their Hidden/Forsaken/Forlorn variants for the five pirate factions) with exact
client geometry and the `combat_anomaly` universe spawn profile. The official
`evejs.ded-rated-sites` pack adds 50 DED-rated pirate and Rogue Drone combat
complexes (ratings 1/10 through 8/10 and 10/10) with exact client layouts and
gate restrictions. Forty-eight may appear as signatures through the
`ded_rated` profile; two Rogue Drone templates are escalation-only. The official
`evejs.drone-anomalies` pack adds the ordinary rogue drone combat anomalies
(Drone Cluster, Collection, Assembly, Gathering, Surveillance, Menagerie,
Herd, Squad, Patrol, Horde) with exact client geometry and the
`drone_anomaly` universe spawn profile; they spawn in every ordinary region
and five times as densely in the eight drone regions. The official
`evejs.ghost-sites` pack adds the 20 Covert Research Facilities (Lesser in
high-sec, Standard in low-sec, Improved in null-sec, Superior in wormholes)
with their exact research caches, response fleets and the `ghost` universe
spawn profile. The official `evejs.wormhole-sites` pack adds the 48 Sleeper
sites of wormhole space (24 combat anomalies, 12 Unsecured data sites and 12
Forgotten relic sites of classes 1 to 6) with their exact towers, databanks
and artifacts, the `wormhole_anomaly`, `wormhole_data` and `wormhole_relic`
universe spawn profiles, and the `wormhole_ore` profile that schedules the ore
pack's wormhole deposits; each class hosts only its own sites. A base
installation works without any pack and does not schedule those sites;
persisted sites from a removed pack are dropped safely at the next server
start.

The official `evejs.pirate-exploration` pack adds the 204 pirate relic and data
cosmic signatures with their exact hackable containers: Crumbling and Local
sites in high-sec, Decayed and Regional in low-sec, Ruined and Central in
null-sec and low-class wormholes. The official `evejs.gas-sites` pack adds the
74 gas signatures, placing the Mykoserocin nebulae in high, low and null
security, the Cytoserocin nebulae in low and null only, and the fullerite
reservoirs in the wormhole classes each belongs to. The official
`evejs.booster-production` pack adds the 32 booster production sites: the
low-security Chemical Labs, Gas Processing Sites and Distribution Bases and the
null-security Production Facilities and five-room Digital complexes.

The official `evejs.mining-missions` pack adds the 40 agent mining mission
sites, across levels 1 to 4, with the client's own asteroids: the right ore, the
right number of rocks, in the right places, holding exactly what the mission
asks for. It is the one pack with no spawn profile, because nothing seeds a
mission into a system: an agent hands it out. Without the pack a mining agent
has nothing to offer, since the mission sites live in it. Note that a mining
mission site holds exactly the amount the mission requires and no more, so
every rock has to be mined dry - that is what retail does.

The packs are independent: install any combination (the wormhole ore family
needs the ore pack to schedule anything). Every `ContentPacks.bat` command
below works the same way for each pack file, with `--id evejs.combat-anomalies`,
`--id evejs.ded-rated-sites`,
`--id evejs.drone-anomalies`, `--id evejs.ghost-sites`,
`--id evejs.wormhole-sites`, `--id evejs.pirate-exploration`,
`--id evejs.gas-sites`, `--id evejs.booster-production` or
`--id evejs.mining-missions` for `remove` and `rollback`.

The official `evejs.incursions` pack supplies all fifteen Sansha encounters:
Scout, Vanguard, Assault, Headquarters and both final sites. It replaces the
former `evejs.incursion-vanguard` and `evejs.incursion-sites` packs as one unit.
Use `--id evejs.incursions` for removal. See the
[incursion builder](../tools/Incursions/README.md) for reproduction and verification.

Sites know which security bands they belong to. A pack template can name the
bands its site spawns in, and the engine refuses to place it anywhere else.
This is how a Hidden Hideaway stays in high-sec while a Hidden Den is a low and
null-sec site, and why version 1.1.0 of the combat-anomaly pack replaces 1.0.0:
the earlier version scheduled anomalies by their client difficulty, which put
the Hideaway variants out of high-sec and let low-sec host sites that belong to
null.

## The folder is the source of truth

Every release ships its packs in a folder called `content-packs` inside the
installation, and **the server installs whatever is in there when it starts**.
There is nothing to run and nothing to click.

| What you want | What you do |
|---|---|
| The packs the release comes with | Nothing. Start the server. |
| A pack from somewhere else | Put its `.json` file in `content-packs` and start the server. |
| To run without a pack | Delete its file from `content-packs` and start the server. |
| A newer version of a pack | Put the new file in. The newest version wins; delete the old file to keep the folder tidy. |

Deleting a file is the way to turn a pack off, so anything removed another way
comes back on the next start. Removal only deactivates a pack: the copy in your
game store is kept, so putting the file back switches it on again without
another download.

The server reports what it did in its log, for example
`[ContentPacks] installed 9 content pack(s): ...`. It does the work only when the
folder or the installed set has actually changed — an unchanged start costs
nothing.

**Two versions of the same pack in the folder** is not an error. The newer one is
installed and the older is ignored, with a line in the log naming the file to
delete. Versions are compared as numbers, so 1.10.0 beats 1.9.0.

The source repository ships one current file per **manifest ID**. When publishing
an update, remove its superseded files from this folder; different IDs (including
Security mission levels 1–5) remain separate packs. Historical releases remain in
Git history. Current-content tests select the latest family through
`resolveContentPackPath`; migration tests retain only the legacy scene/state
inputs they need under `server/tests/fixtures`, rather than whole old packs.
`contentPackFiles.test.js` validates the shipped packs and rejects duplicate IDs.
The ignored `content-packs/build` directory contains compiler inputs and scratch
output, not additional installable pack versions.

**The newest version always wins.** The server never replaces an installed pack
with an older version. If you installed 1.0.3 of a pack yourself and
`content-packs` holds the release's 1.0.2, 1.0.3 stays, and the log says so. To
go back to an older version on purpose, [roll back](#roll-back-or-reactivate-a-retained-version).

Deleting the whole folder is different from emptying it: an empty folder means
"no packs, please", while a missing folder is left alone, because an older
installation never had one.

## The command line

The rest of this page is `ContentPacks.bat`, which does the same work by hand.
Nobody needs it for ordinary use — adding or deleting a file in `content-packs`
covers that — but it is what to reach for on a headless host, in a script, or
when you want to see exactly why a pack was refused.

Anything it changes is subject to the folder on the next start: activate a pack
whose file is not in `content-packs` and the server will deactivate it again.
Put the file where you want the outcome to stick. The exception is a newer
version of a pack the folder has: it stays even though the folder only has an
older one.

## Updating a pack

Installing a newer version of a pack you already have is just an install. The new
version becomes active and the old file is retained, so
[rollback](#roll-back-or-reactivate-a-retained-version) still works:

```powershell
.\ContentPacks.bat install --pack C:\Downloads\evejs-ore-anomalies-1.1.0.json
```

That reports `Updated evejs.ore-anomalies from 1.0.0 to 1.1.0`.

Installing an *older* version than the active one does not switch to it. The
file is stored, the newer version stays active, and the command reports
`Kept evejs.ore-anomalies@1.1.0, which is newer than 1.0.0` with the rollback
command that would switch to it.

A pack version is immutable: a *different build* carrying a version you already
have is refused, because rolling back to a version has to mean the same content
every time. The answer is normally to ask for a build with a higher version
number. When that is not possible — a corrected build you cannot renumber — say
so explicitly:

```powershell
.\ContentPacks.bat install --pack C:\Downloads\evejs-ore-anomalies-1.0.0.json --replace
```

`--replace` overwrites the stored file, so a later rollback to that version
returns the new content. The updater asks before doing this; a console run of the
updater needs `-ReplacePacks`.

## Installing a folder of packs

```powershell
.\ContentPacks.bat import --dir .\content-packs
.\ContentPacks.bat import --dir .\content-packs --dry-run
```

`import` installs every `*.json` pack in one folder and reports what each one
did: installed, updated, replaced, already installed, skipped, or failed. A file
that fails does not stop the others. `--dry-run` reports the same thing and
writes nothing, which is how `SetupEveJS.bat` checks whether there is anything to
do without installing on every status pass.

## Verify a downloaded pack

Official releases publish a canonical pack SHA-256 alongside each pack. Before
installing, run `verify` and compare the printed digest with the digest published
through the official release channel:

```powershell
.\ContentPacks.bat verify --pack C:\Downloads\evejs-ore-anomalies-X.Y.Z.json
```

Verification checks the JSON schema, content counts, internal payload hash, and
compatibility with the installed EVE.js version. Packs are not currently signed,
so digest comparison is also the authenticity check. The printed digest is the
canonical JSON pack hash; it is not the raw byte hash reported by
`Get-FileHash`, and the two values are not expected to match.

## Native Windows installation

Stop the EVE.js server, then run these commands from the EVE.js installation
directory:

```powershell
.\ContentPacks.bat verify --pack C:\Downloads\evejs-ore-anomalies-X.Y.Z.json
.\ContentPacks.bat install --pack C:\Downloads\evejs-ore-anomalies-X.Y.Z.json
.\ContentPacks.bat doctor
.\ContentPacks.bat status
.\StartServer.bat
```

`install` copies the validated pack into the persistent game store and makes that
version active, unless a newer version of the pack is already active. The
downloaded file can be moved or deleted after installation.
Installing a newer version of the same pack activates the new version and keeps
the previously installed version available for rollback.

Wait for the server log to report `EveJS Elysian is running!` before launching
the client.

## Native Windows removal

Stop the server, remove the pack from the active set, validate the remaining
registry, and restart:

```powershell
.\ContentPacks.bat remove --id evejs.ore-anomalies
.\ContentPacks.bat doctor
.\ContentPacks.bat status
.\StartServer.bat
```

Removal takes effect on restart. It deactivates the pack and removes its runtime
content, but retains the managed versioned file for rollback. For the official
ore pack, EVE.js safely removes persisted ordinary universe ore sites during
startup when the pack is absent.

`status` reports the active pack set. Once a pack is removed it reports no active
entry for that pack and does not list its retained versions, so record the active
version before removal if you may want to roll back later.

## Roll back or reactivate a retained version

With the server stopped:

```powershell
.\ContentPacks.bat rollback --id evejs.ore-anomalies --version X.Y.Z
.\ContentPacks.bat doctor
.\StartServer.bat
```

Rollback selects an already stored version; it does not require the original
download. It is the only way to move a pack to an older version. If
`content-packs` holds a newer file for that pack, the next start moves back to
it, because the newest version wins; to stay on the older version, replace the
newer file in `content-packs` with the older one. There is no separate
permanent-purge command. Do not manually delete
an active managed `pack.json`, because the server deliberately fails startup if
the registry points to missing or modified content.

## Docker installation

The downloaded pack only needs to be mounted into the one-shot content-tools
container while it is verified and installed. In PowerShell:

```powershell
docker compose stop server

docker compose run --rm --no-deps `
  --volume "C:\Downloads:/packs:ro" `
  content-tools verify --pack /packs/evejs-ore-anomalies-X.Y.Z.json

docker compose run --rm --no-deps `
  --volume "C:\Downloads:/packs:ro" `
  content-tools install --pack /packs/evejs-ore-anomalies-X.Y.Z.json

docker compose run --rm --no-deps content-tools doctor
docker compose run --rm --no-deps content-tools status
docker compose start server
```

Confirm that the server becomes healthy:

```powershell
docker compose ps --all
docker compose logs --tail 100 server
```

## Docker removal and rollback

To remove the active pack:

```powershell
docker compose stop server
docker compose run --rm --no-deps content-tools remove --id evejs.ore-anomalies
docker compose run --rm --no-deps content-tools doctor
docker compose start server
```

To reactivate a retained version instead:

```powershell
docker compose stop server
docker compose run --rm --no-deps content-tools rollback `
  --id evejs.ore-anomalies --version X.Y.Z
docker compose run --rm --no-deps content-tools doctor
docker compose start server
```

## Where installed pack data is stored

The installer manages this layout beside the persistent game store:

```text
<storeRoot>/content-packs/
  installed.json
  packs/
    <pack-id>/
      <version>/
        pack.json
```

`installed.json` selects one active version for each pack ID. The server reads
the managed `pack.json`, not the file originally passed to `install`.

The default native Windows location is:

```text
<EVE.js installation>/_local/gameStore/content-packs/
```

The default Docker location is inside the persistent `evejs-data` volume:

```text
/var/lib/evejs/gameStore/content-packs/
```

Normal emulator upgrades, Docker container replacement, and the ordinary local
database reset retain installed packs. A full local database reset removes them.

To manage a non-default native store with the batch file or direct Node CLI,
provide its store root explicitly:

```powershell
.\ContentPacks.bat status --store-root D:\EveJSData
.\ContentPacks.bat install --pack C:\Downloads\pack.json --store-root D:\EveJSData
```

Those commands use `D:\EveJSData\content-packs`. Advanced deployments can use
`--content-packs-dir PATH` to select the content-pack directory directly. The
standard Docker content-tools service pins its store root to
`/var/lib/evejs/gameStore`; use the documented Docker commands unless you have
also supplied a persistent custom mount.

## Troubleshooting

- `verify` rejects an incompatible engine version, malformed data, incorrect
  counts, or a mismatched internal hash. Obtain a compatible pack; do not edit it.
- `install`, `rollback`, and `doctor` require an initialized target game store so
  they can validate packs against that server's core dungeon tables. Complete
  normal EVE.js setup (or the Docker `init` service) first.
- `install`, `rollback`, and `doctor` also build the effective dungeon authority
  in memory. Template, source-dungeon, or spawn-profile collisions with the base
  game or another active pack are rejected before the active registry changes.
- A different file reusing an existing pack ID and version is rejected. Pack
  versions are immutable.
- If an install, removal, or rollback was performed while the server was still
  running, stop and restart it. The running process intentionally keeps its
  startup snapshot until shutdown.
- Use `.\ContentPacks.bat status` or
  `docker compose run --rm --no-deps content-tools status` to confirm the active
  set before starting the server.
