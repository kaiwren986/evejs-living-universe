# EvEJS content packs

Content packs are data-only additions installed beside a server's persistent game
store. They are loaded on startup; hot reload is deliberately unsupported.

**The server installs them itself.** Whatever sits in the installation's
`content-packs` folder is installed when the server starts, and a pack whose file
is gone is removed, so this tool is not needed in normal use. It is for headless
hosts, scripts, and working out why a pack was refused. Anything it changes is
subject to the folder on the next start, with one exception: the newest version
of a pack always wins, so a newer version installed here stays even when the
folder only has an older one.
See [the full installation and removal guide](../../doc/CONTENT_PACKS.md) for
native and Docker procedures, storage details, and troubleshooting.

`verify` checks schema and internal hashes. For an official download, also compare
the printed canonical pack SHA-256 with the digest published through the release
channel; the current local format does not carry a publisher signature. This is
the canonical JSON hash, not the raw byte hash printed by `Get-FileHash`.

Verify the download and compare its canonical digest first. Then stop the server,
install the pack, and start the server again:

```powershell
.\ContentPacks.bat verify --pack C:\Downloads\evejs-ore-anomalies-X.Y.Z.json
.\ContentPacks.bat install --pack C:\Downloads\evejs-ore-anomalies-X.Y.Z.json
.\StartServer.bat
```

Useful commands:

```powershell
.\ContentPacks.bat status
.\ContentPacks.bat doctor
.\ContentPacks.bat remove --id evejs.ore-anomalies
.\ContentPacks.bat rollback --id evejs.ore-anomalies --version 1.0.0
```

`import` installs every pack in one folder and is what `SetupEveJS.bat` and
`UpdateEveJS.bat` call, so a first-time setup picks up whatever is sitting in the
installation's `content-packs` folder:

```powershell
.\ContentPacks.bat import --dir .\content-packs
.\ContentPacks.bat import --dir .\content-packs --dry-run
```

It is safe to re-run, reports each file separately, and a file that fails does
not stop the rest. When a folder holds several versions of the same pack, only
the highest is installed: filename order would let `1.9.0` land after `1.10.0`
and downgrade the pack.

Installing a higher version of an installed pack is an ordinary install and
reports as an update; the old version file is retained for rollback. Neither
`install` nor `import` ever moves a pack to a lower version: the older file is
stored for rollback, the newer version stays active, and the tool reports it as
kept. `rollback` is the way back to an older version. A
*different build* of a version that is already installed is refused, because
rollback to a version must mean the same content. `--replace` overrides that for
a corrected build that cannot be renumbered, and overwrites the stored file.

`install`, `rollback`, and `doctor` build the effective dungeon authority in
memory. They reject template, source-dungeon, and spawn-profile collisions with
the base game or another active pack before changing the active registry.

Use `--store-root PATH` when managing a store other than the default. Installed
versions live under `<storeRoot>/content-packs`; removing a pack deactivates it but
retains its immutable file so it can be selected again with `rollback`.

The official ore-anomaly pack contributes 199 ore anomaly templates and the ore
universe spawn profile. Without it, those templates are absent and ordinary ore
anomalies are not scheduled.

The official combat-anomaly pack (`evejs.combat-anomalies`) contributes the 176
ordinary pirate combat anomalies compiled from client build 3475087 and the
`combat_anomaly` universe spawn profile. Without it, no ordinary pirate anomaly
is scheduled and any persisted one is removed at the next server start.

The official DED-rated-site pack (`evejs.ded-rated-sites`) contributes 50
ratings 1/10 through 8/10 and 10/10 complexes from client build 3475087 and the
`ded_rated` profile. Forty-eight signature templates follow their security band
and local pirate faction (Rogue Drone signatures are ordinary-space neutral);
two Rogue Drone templates remain escalation-only. Without it, no DED-rated
template is served or scheduled and stale persisted instances are removed.

The official drone-anomaly pack (`evejs.drone-anomalies`) contributes the 22
ordinary rogue drone combat anomalies (Drone Cluster to Drone Horde) from the
same client build and the `drone_anomaly` universe spawn profile, which places
them in every ordinary region by tier and security band and five times as
densely in the eight drone regions. Without it, no drone anomaly is scheduled.

The official ghost-site pack (`evejs.ghost-sites`) contributes the 20 Covert
Research Facilities (Lesser in high-sec, Standard in low-sec, Improved in
null-sec, Superior in wormholes) with their exact research caches and the
`ghost` universe spawn profile, which keeps them uncommon. Without it, no ghost
site is scheduled.

The official wormhole-site pack (`evejs.wormhole-sites`) contributes the 48
Sleeper sites of wormhole space (24 combat anomalies, 12 Unsecured data sites,
12 Forgotten relic sites of classes 1 to 6) with their exact towers, databanks
and artifacts, the `wormhole_anomaly`, `wormhole_data` and `wormhole_relic`
universe spawn profiles, and the `wormhole_ore` profile that schedules the ore
pack's wormhole deposits by class. The engine's wormhole class rule keeps each
site in its class (shattered systems, Thera and the small-ship shattered
systems widen the band). Without it, wormhole space hosts no Sleeper site.

The official pirate-exploration pack (`evejs.pirate-exploration`) contributes
the 204 pirate relic and data signatures with their exact hackable containers.
Each site names the security band its tier belongs to: Crumbling and Local in
high-sec, Decayed and Regional in low-sec, Ruined and Central in null-sec and
wormhole classes 1 to 3. These sites hold no NPCs, which is how they have
worked since the Odyssey expansion removed the spawns in 2013.

The official gas-site pack (`evejs.gas-sites`) contributes the 74 gas
signatures and owns the gas_nebula and wormhole_gas families. A site's band
follows the gas it holds: Mykoserocin reaches high, low and null security,
Cytoserocin only low and null, and the fullerite reservoirs only the wormhole
classes each tier belongs to.

The official booster-production pack (`evejs.booster-production`) contributes
the 32 drug production sites: low-security Chemical Labs, Gas Processing Sites
and Distribution Bases, and null-security Production Facilities and the
five-room gated Digital complexes, all with their exact containers and waves.

The official mining-mission pack (`evejs.mining-missions`) contributes the 40
agent mining mission sites across levels 1 to 4 - 34 ore, 3 ice, 3 gas - with
the client's own rocks and room scenery. It owns no spawn family and ships no
spawn profile: nothing seeds a mission into a system, so the mission runtime
resolves the site by its dungeon id when an agent hands the mission out. The
mining agent gate reads the installed authority, so removing this pack narrows
what agents offer instead of sending a player to a site that is not there.

`verify` and `install` also refuse a pack that declares a capability this engine
does not implement, so a pack built for a newer engine fails before it is
installed rather than misbehaving at runtime.

Docker users can mount a supplied pack into the content-tools container:

```sh
docker compose stop server
docker compose run --rm --no-deps \
  -v /absolute/path/to/packs:/packs:ro \
  content-tools install --pack /packs/evejs-ore-anomalies-X.Y.Z.json
docker compose start server
```
