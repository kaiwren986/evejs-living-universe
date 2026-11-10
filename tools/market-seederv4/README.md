# Iron Man Market Seeder v4

Iron Man seeds only authentic NPC station orders from the Tranquility snapshot:
blueprint originals, skillbooks, planetary command centers, trade goods and other
NPC stock. NPC trade-good buybacks are included. Players must obtain other goods
through gameplay and industry.

Orders retain their original stations, prices and snapshot quantities. There is
no synthetic Jita hub or custom-station stock. Only orders with duration greater
than the normal 90-day player limit qualify, using the same NPC identification
as the existing snapshot seeders. Items absent from the snapshot are not invented.

From the repository root, run:

```text
tools\market-seederv4\BuildMarketSeedV4.bat
```

Choose `[1]` to build. The other options show snapshot information, inspect the
database, compile the importer or edit `config/market-seederv4.local.toml`.
Pass `yes` to the launcher to build without the overwrite prompt.

This fourth seed type reuses the v2 Rust importer and its snapshot cache. It needs
Rust, generated static data and network access to the snapshot index. The launcher
always selects the strict Iron Man filter, even if the config's filter changes.
The fixed NPC duration boundary and disabled custom station cannot be overridden
in Iron Man mode.

Direct CLI (paths resolve from `tools/market-seederv2`):

```powershell
cd tools\market-seederv2
cargo run --release -- --config ../market-seederv4/config/market-seederv4.local.toml build --order-filter iron-man
```

Docker uses the existing candidate validation, backup and rollback workflow:

```powershell
docker compose stop server market
docker compose run --rm --no-deps market-tools rebuild v4
docker compose up -d server market
```

Docker reuses a matching cached v2 snapshot by default. Add `--fresh-download` to
fetch it again. Conflicting `--order-filter` arguments are rejected.

Like the other seed types, rebuilding replaces the market database, including
player orders and history. Stop the market server before a local rebuild. This
mode controls initial market stock; it does not restrict character creation,
mission rewards or GM commands.
