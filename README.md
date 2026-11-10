# EVE.js

EVE.js is a local EVE Online server emulator. This release targets **EVE 24.01 build 3396210**, validated against the client and static-data export from June 16, 2026.

Join the project Discord: [https://discord.gg/KMuJrMDEBa](https://discord.gg/KMuJrMDEBa)

## Localhost only

> **EVE.js is a localhost-only project. Run the server and EVE client on the same computer.** It is not hardened for a LAN, the public Internet, port forwarding, shared hosting, or untrusted users.

The supported address is `127.0.0.1`. The Docker configuration publishes every required port specifically on `127.0.0.1`, and native listener defaults are also loopback-only. Do not remove the `127.0.0.1:` prefixes from `compose.yaml`, change bind settings to `0.0.0.0` on the host, or forward these ports through your router.

## Getting started

Docker is the recommended backend setup. Native Windows installation is also supported.

- [Recommended Docker setup](doc/SETUP.md#recommended-setup-docker)
- [Native Windows setup](doc/SETUP.md#native-windows-setup)
- [Browser companion setup](doc/SETUP.md#browser-companion)

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
- [Jita index seed design plan](doc/JITA_INDEX_SEED_PLAN.md)
- [Troubleshooting](doc/TROUBLESHOOTING.md)
- [Tools and admin basics](doc/TOOLS.md)
- [Non-Docker setup audit and improvement report](doc/NON_DOCKER_SETUP_AUDIT.md)

Lots works; lots does not.
