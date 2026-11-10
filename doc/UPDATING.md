# Updating EvEJS

Everything your server remembers — accounts, characters, ships, wallets, uploaded
portraits, and market state — is kept separately from the program files.
Updating is therefore always the same idea: **replace the program files, keep the
data.** You never need to rebuild the game database to install a new version.

There are two ways to do it.

`config/gameplay.json` now accepts `skinr.skinrDesignIterationMultiplier`
(environment override: `EVEJS_SKINR_DESIGN_ITERATION_MULTIPLIER`). Its default
`1` preserves the standard saved-design capacity. Values from `0` to `100`
scale only the earned Design Iteration bonus; base slots and Design Concepting
are unchanged. With both skills V, `2` gives 220 slots and `5` gives 505.
Fractional totals round down. Config initialization supplies the default for
older files. Restart the server and relog after editing it. Lowering the limit
retains existing designs and permits editing/deletion, but new saves/imports
require space below the new capacity. No database migration is needed.

SKINR design export/import adds `skinr/designs/` under the data root (normally
`_local/skinr/designs/`). The folder is created when first needed. Keep exported
`.skinr.json` files with your backups, and copy received files there before using
`/skinr import <filename.skinr.json>`. These version-one files contain design
recipes; importing creates a saved draft in the existing game store without
granting component rights or SKIN licenses. Existing drafts need no migration.
Restart the server after updating; relog if an imported design remains absent
from the client's cached saved-design list. See [the command guide](CommandGuide.txt).

Local Aura guidance adds its native UI flag to the offline server contract:
version 4, `local-supported-features`, and exactly the achievement, character-title
and Aura-guidance booleans. Update both server program files and `tools/ClientSETUP`,
restart the server and fully restart the client. An old running server will fail
the updated Play gate until restarted. No world-data migration, AI credentials
or external service is required. See [local Aura guidance](AURA_GUIDANCE.md).

Account license notices add versioned `licenseLifecycle` metadata within each
`newEdenStoreRuntime.accounts` record. Keep its pending outbox, stable revision,
expiry and training-rate history with account fulfillment receipts, characters,
skills, skill queues and scheduled jobs in backups/restores. Missing metadata is
initialized from the existing effective entitlement; no donor runtime import or
database rebuild is required. Pre-port unrecorded grant timing is unavailable.
See [license notices and historical training rates](USER_LICENSE_NOTICES.md).

Local Project Discovery adds a versioned `characters.projectDiscovery` field on
first use. Keep it with the character when backing up or restoring progress:
it includes tutorial proofs/claim, XP/AK, remaining introductory bonuses and the
issued-task/submission receipt. Previous in-memory placeholder progress was not
durable and cannot be reconstructed. No database rebuild or donor-data import
is required. Six authored sample images are generated from program data. See
[local Project Discovery](PROJECT_DISCOVERY.md).

Faction Warfare occupation queries now project the existing `fwOpenReplay`
state and the two authored Command Operations placements. No database rebuild,
donor data import or occupation reset is required. Preserve `fwOpenReplay`,
`lpWallets`, `campaignTrailProgress`, `achievements` and character AIR progress
together when backing up or restoring pending completions. Existing receipt
identities remain valid; old completed complexes do not pay again. Restart the
server and client to refresh native FW state. See
[FW occupation and query scope](FACTION_WARFARE_OCCUPATION.md).

AIR Career Program ships its authored catalog with program files;
no donor runtime import or static rebuild is needed. Preserve character
`careerProgramProgress` and `careerHackingEvidence`, account
`newEdenStoreRuntime.careerProgramClaims` and queued tokens/redemptions, and the
corresponding item, wallet, SP and scheduler receipts together. Mining adds
permanent `miningLedger.careerOreQuantities` totals, backfilled from retained
history before ordinary 90-day pruning. Keep these with mining receipts and
character progress. Hacking receipts depend on durable site/container identities;
back up `dungeonRuntimeState` and `identityState` consistently. New NPC ship
killmails retain internal `careerNpcShip` provenance; old unmarked kills are not
credited by inference. See [AIR career content](AIR_CAREER_PROGRAM.md).

Data/relic minigames add `spawnState.hackingContainers` to existing
`dungeonRuntimeState` instances. These records retain failure counts, terminal
container state, outcome receipts, prepared career evidence and effect-delivery
checkpoints. Homefront operation state in `homefrontReplay` adds
`hackOutcomeReceipts`. Preserve these tables with `identityState`, item custody
and character career evidence from the same backup generation. Fields are
created when needed; no data migration, static rebuild or reset is required.
Partial boards are transient and do not resume after restart. See
[hacking and archaeology](HACKING.md).

Special hacking policies also retain Observatory's permanent server sealed state (3)
in the same journal. Item scope carries the authored seal/never-destroy/finale
flags; runtime hydration restores the terminal journal state before admission.
Keep item custody and dungeon state together when restoring backups. Existing
instances without a recorded seal retain their previous state; no historical
first failure is inferred into a seal during upgrade.
New materialized hacking sites freeze their authored container layout in
`spawnState.hackingContainerLayout` before creating containers or loot. Sites
with pre-existing content refs/outcomes retain the previous layout and keys,
so adopting curated content cannot regenerate an already resolved cache.
Ghost encounter state retains absolute phase deadlines and
`spawnState.siteExplosionClaims` records processed cache blasts. Sleeper cloud
position, private scope, ticks and expiry live in `hazardState.sleeperToxicCloud`.
These optional fields share the existing dungeon backup boundary.

Prepared hazard hits now live in `spawnState.siteHazardDamageEventsByID`, with
cloud tick target markers in `spawnState.siteHazardDamageTicksByID`. Each hit
retains its original hull identity, custody revision, damage and time until
health and any lethal consequences settle. The existing `items` receipt ledger
adds `site-hazard-damage` and `site-hazard-death-settled` operations; health and
its receipt commit together. Generic capsule deaths retain
`characters.durablePodDeathReceipts` placement/implant checkpoints. Preserve
these with dungeon state, items, characters, insurance, notifications and ship
kill counters from the same backup generation. Recovery runs before scene and
pilot activity, and failed delivery blocks removal of its source instance.
There is no new table, static rebuild or reset. Older explosion claims without
a prepared hit cannot reveal which ships were hit and are not replayed.

Additional AIR activity adapters retain `characters.careerActivityEvidence`:
bounded server-owned receipt identities and capped totals for accepted gameplay.
Keep this field with character progress and reward claims. It uses cents for
paid bounty evidence, milliseconds for applied EWAR time, and fixed-point HP/GJ
for measured combat effects; public AIR progress remains whole units. Metrics
stop growing at the largest supported goal and receipts are never evicted to
make an action count twice. The client cannot submit these counters.

Travel adapters add optional `characters.careerPendingGateArrival`, preserving
an accepted transition's ship/source/destination identity until item custody and
character progress agree. Version-two intents use the existing permanent
`items.__evejsInventoryGrantReceipts` ledger for atomic gate movement proof,
including after the original body moves or is destroyed. Keep these receipts
with character state; do not prune them independently. Prepared moves with no
accepted receipt cannot earn credit. Old version-one intents whose original
body/proof is already unavailable are retired without credit, preserving the
current capsule/clone and other gameplay. Distinct
region goals read retained `mapTelemetry` visits. New hacking receipts retain
system/security provenance; old metadata-poor receipts do not earn restricted
hacking goals. No existing AIR goal identities, earned points or claims change.

Mission progress retains `careerProgramMissionEvidence` inside each character's
`missionRuntimeState` entry, independently of the pruned mission journal. Native
player mail records `mail.careerPlayerMailSent`. Preserve these with character
progress, mission reward/standing receipts and account claims. Bounty and LP
adapters retain their existing settlement intents until AIR evidence commits;
back up the associated wallet/item receipts consistently. There is no static
rebuild, donor data import or reset of existing progress.

Combat adds character `careerFwEnlistment` history and frozen killmail
`careerFwFinalBlowCharacterID`, `careerFwFinalBlowFactionID`,
`careerFwVictimFactionID` and `careerFinalShipTypeID` provenance. The last field
records a validated drone controller hull without altering native killmail ship
attribution. Private Abyssal pockets retain `careerCombatOutcomes` until their
career consumer settles before cleanup. Preserve `dungeonRuntimeState`, killmail,
character and reward records consistently; old missing provenance is not guessed.

Measured combat effects add inventory-owned `items.__evejsCareerCombatOutcomes`.
Each accepted outcome and its affected persistent ship conditions share an
atomic item checkpoint. Keep this permanent source/acknowledgement ledger with
character activity evidence and reward/account receipts. It survives destruction
of the original ships and must not be pruned to make a cycle replayable. No SQL
schema rebuild is needed. A downgrade requires a complete consistent backup.

Login campaigns add optional `gameplay.json` setting `rewards.loginCampaigns`.
Existing files receive an empty default without changing the daily or Gallente
event schedules. Claims retain `loginCampaignProgress`, `campaignTokenSequence`
and owner-bound `campaignRedemptions` in each `newEdenStoreRuntime` account.
New campaign queue tokens retain their frozen `campaignGrant` identity. Preserve
this table together with `items`, `characters`, `industryBlueprintState`,
`lpWallets`, `characterExpertSystems`, `walletAuthorityState` and scheduler state when backing up. Campaign
wallet and SP/custody receipts must remain with their delivered rewards. There
is no donor runtime import or static database rebuild. See [campaigns](LOGIN_CAMPAIGNS.md).

Character re-sculpt activations now retain an owner-bound fulfillment record in
`characters.resculptActivation`, with the corresponding consume receipt in
`items`. Keep both tables from the same backup generation. Startup recovers
pending activations through the durable scheduler. No static rebuild, donor
activation history or data reset is required.

NPC mining cargo now stores revision receipts and hidden removal tombstones in
the existing `npcCargo` table. The mining-owned `miningCargoCommits` table retains
extraction intents and the latest producer cycles. Preserve these tables with NPC
entity and mining state when backing up. They are created automatically; no
static-data rebuild or donor runtime import is needed.
Mined-ore wreck handoff intents live in `npcCargo.miningTransfers`; preserve them
with `npcWrecks` and `npcWreckItems`. Do not restore these legs from different
backup generations. The source NPC may remain disposable while its completed
ore wreck persists until normal expiry.

Auction contracts extend existing `contractRuntime` and `contractSettlements`
records with frozen fee terms and recoverable operations. Character wallets now
retain contract receipt identities separately from rolling journal history.
Keep these tables with item custody and corporation wallet state during backup
and restore. No database rebuild or donor runtime import is needed.

Freelance Projects now use a domain-owned `freelanceProjects` runtime table for
funded jobs, participant progress and settlement intents. It is created on demand;
no static rebuild or donor data import is needed. Keep it with character and
corporation wallet/custody data when backing up. Character wallet receipts now
retain freelance settlement identities separately from the rolling journal.

The achievement and character-title UI are now enabled by the server's narrow
local flag response. Update the program and ClientSETUP scripts together, restart
the server, then fully quit and relaunch the client through Play. The launcher
requires version 3 health with the two enabled flags; a stale server fails with
a restart message. No data reset, catalogue rebuild or client gameplay patch
is needed. See [in-game achievement testing](ACHIEVEMENTS.md#in-game-testing).

Native achievements now retain stable completion receipts in the existing
`achievements` table. Ordinary dungeon instances may retain
`spawnState.achievementCompletionCharacterIDs` while earned progress retries;
successful Abyssal exits retain their canonical roster until credited.
`crimewatchRuntime` may contain `duelAchievement` intent rows, and new FW
killmails may contain server-only `achievementFwWinnerCharacterID` evidence.
Keep these runtime tables together during backup/restore. No data rebuild,
new static catalogue or client change is needed. See [achievement coverage](ACHIEVEMENTS.md).

Fitted-item Trade now retains the original module identity in loaded-charge
return origins. New trades preserve this field through staging and cancellation
recovery. A historical fitted-charge origin without that identity stays pending
for inspection rather than choosing a different module in the same slot.
No reset or data rebuild is needed.

Asset safety now calculates automatic NPC destinations by solar-system distance
and security class. On service recovery, eligible undelivered records using the
old calculated fallback are updated in place. Delivered records, selected
destinations, delivery/recovery sagas, and explicit overrides are preserved.
New records store optional `nearestNPCStationInfoSource` provenance. Historical
overrides identical to the old calculation cannot be distinguished from that
calculation; unmatched historical overrides are retained. No reset or data
rebuild is needed.

Asset-safety wraps now register their 20-day deadlines with the existing durable
scheduler. Creation and GM timer changes queue reconciliation; startup recovers
pending collection/delivery work and overdue deadlines without a client fetch.
New completed deliveries store optional `deliveryNotificationStatus` in the same
record as their destination. Pending live cache invalidations are retried;
historical completed deliveries lacking this marker are not replayed. A crash
between socket send and its checkpoint can repeat the harmless invalidation.
No client acknowledgment or exactly-once socket delivery is assumed.

New corporation asset-safety collections retain their original supported
division flags. Their delivery keeps a corporation-owned wrap rather than
unpacking items into a station hangar. `collectionLegs[].destinationFlagID`
preserves each collection command, and `corporationDivisionVersion` records
the retained format. On recovery, an undelivered legacy flag36 collection is
repaired only when its saved source items and committed custody receipts prove
every original division and the items remain unchanged inside that wrap.
Repair has separate durable custody receipts and resumes after interruption.
Ambiguous origins remain pending for inspection; no division is guessed.
Existing unpacking delivery sagas keep their captured route, and already
released assets are never reclaimed. No reset or data rebuild is required.
Corporation access now requires Director/CEO authority. Corporation withdrawal
uses the user-approved emulator policy of charging the actor's active selected
corporation wallet division (default1000), with no personal-wallet or master
fallback on insufficient funds. This is an emulator policy, not captured TQ
payer parity. The recovery saga now stores the acting character separately from
the source owner, frozen payer corporation/division, and each destination owner;
older personal sagas retain their existing interpretation. Changing corporation,
authority or the selected division cancels pending work and refunds its original
division. Completed custody receipts settle before these new-action checks.
Corporate adjustment receipts commit with balance/journal in the existing wallet
authority's owner record (or corporationRuntime in compatibility mode) and are
retained per division as adjustmentReceipts. Reused keys cannot apply money twice;
the bounded receipt limit refuses new keys instead of evicting replay evidence.
Refunds opt into exact credit and remain pending if the wallet cannot accept the
full amount. No database rebuild is required.
Personal safety roots can also be recovered directly into an accessible local
office division of the actor's current corporation. The fee still comes from
the personal wallet; the destination corporation owns the recovered root and
all its contents. Pending operations retain their original destination owner
and recheck current membership/division access after awaiting payment and on
restart. No new client argument or stored schema change is needed.
Ordinary containers inside delivered personal or corporation safety wraps now
support nested recovery. New recovery sagas use schema3 and retain the immediate
`sourceLocationID` plus each leg's `sourcePath`, ordered from its immediate parent
out to the wrap. Parent identity, owner, location, flag, singleton state and
quantity are rechecked after payment and on restart. Existing schema1/2 sagas
keep their direct-root interpretation; no historical ancestry is invented.
Rollback first resolves its durable custody receipt, then requires unchanged
original ancestors and recovered contents before returning items and refunding
the original payer. Changed ancestry or contents leave compensation pending for
inspection rather than refunding while custody is unresolved. Partial-stack
compensation may return the split stack separately beside its source remainder.
No database reset or rebuild is required.
Unsupported corporate source flags, including controlled-structure cargo5,
remain in their existing custody and cause collection/handoff to fail. The
structure lifecycle keeps the structure pending instead of deleting those
items or assigning an invented hangar division.

SKINR adds immutable `shipSkinComponentAuthority` and
`shipSkinSequencingAuthority` tables and SQLite-backed
`shipSkinComponentRuntime` rights/receipts, `shipSkinDraftRuntime` designs,
`shipSkinSequencingRuntime` jobs and `shipSkinThirdPartyRuntime` output rights.
The latter also retains listings, escrow, transaction phases and fee audits.
Market policy is `shipSkinMarketAuthority`; optional server-authored component
offers are `shipSkinComponentListingAuthority` (empty by default). Both are
immutable installed reference tables, not donor runtime records. Ship inventory
rows may contain an optional owner-bound `skinrApplication` and its existing
inventory receipt ledger; transfer and packaging clear the application. Existing
characters and conventional SKINs require no destructive migration. New
applications also retain their inventory receipt key and the conventional-paint
preimage in receipt metadata. Retries finish interrupted cleanup only for that
exact application; older requests cannot clear a later paint. Existing rows
without these optional fields remain readable and need no migration. Conventional
ship appearance records add `appearanceRevision` on their next write, so two
paint changes in the same millisecond still have distinct identities.
After updating the program files,
run `node scripts/DataSync/install-skinr-static.js` from the repository root and
restart the server. This copies only reviewed SKINR static tables into the
configured gameStore data directory. No database rebuild or player-data reset
is needed; existing conventional SKINs and runtime rights are retained. See
[SKINR.md](SKINR.md) for catalogue provenance and verification limits.

The bundled SKINR design store additionally installs `shipSkinStoreAuthority`
with all 1,674 reviewed designs. Run the same installer and restart after pulling
this update. The first reconciliation seeds finite store stock into existing
SQLite SKINR state. Existing characters, rights, drafts, jobs, listings and
receipts are retained. Re-running the installer or restarting does not restock
sold designs; no database rebuild or player-data reset is required.

| | [With the updater](#the-updater) | [By hand](#updating-by-hand) |
|---|---|---|
| What it is | `UpdateEveJS.bat`, one window | unpack the release yourself and copy your data across |
| Where it updates | your existing folder, in place | a new folder beside the old one |
| Certificates and launcher config | kept, because the folder does not change | left behind; the client setup has to be redone |
| Needs | Windows | anything |
| Use it when | almost always | you are moving to another PC, running a non-Windows Docker host, or the updater refuses the folder |

The updater is the recommended way and is what to tell people to use. The manual
path is not deprecated: it is the documented fallback, it is what to use for the
cases the updater deliberately will not handle, and it is worth knowing because
it is what the updater is doing for you.

- [The updater](#the-updater)
  - [Mandatory offline client migration](#mandatory-offline-client-migration-19-september-2026)
  - [Updating to a new release](#updating-to-a-new-release)
  - [Content packs](#content-packs)
  - [Server logs moved to `_local\logs`](#server-logs-moved-to-_locallogs)
  - [Old log archives are deleted after 7 days](#old-log-archives-are-deleted-after-7-days)
  - [Certificates moved to `_local\certs`](#certificates-moved-to-_localcerts)
  - [The client firewall blocks are recommended, not required](#the-client-firewall-blocks-are-recommended-not-required)
  - [Moon mining and the moon composition pack](#moon-mining-and-the-moon-composition-pack)
  - [The backup folder](#the-backup-folder)
  - [When something goes wrong](#when-something-goes-wrong)
- [What is kept and what is replaced](#what-is-kept-and-what-is-replaced)
- [Updating by hand](#updating-by-hand)
  - [By hand: native Windows](#by-hand-native-windows)
  - [By hand: Docker](#by-hand-docker)
  - [Older installations](#older-installations)


## Optional pause capture

`EVEJS_PAUSE_PROFILE=1` enables a temporary main-process CPU, GC and event-loop
capture. It writes new run folders under the data root's `logs/pause-profiles/`
directory; nothing is written there unless enabled. Existing runtime data needs
no migration. See [PAUSE_PROFILING.md](PAUSE_PROFILING.md) for the Windows capture
steps. `ProfileServer.bat` now starts both captures and automatically bundles
them with the ErrorReport in one ZIP. Lean ReleaseBuilder output includes the
launcher, counter script and profiling guide. The ordinary ErrorReport still
does not scan unrelated old capture folders.

## Planetary launch IDs

A planetary launch used to be given an ID counted up from 910000000000. The
game client is sent a launch's ID as a 32-bit number, which that does not fit,
so a pilot who had made a launch could not be sent their launch list at all.
Launch IDs are now counted up from 910000000.

Nothing needs doing by hand. The first time the server reads its planetary
data (`planetRuntimeState`) it gives each stored launch a new ID that fits and
keeps the old one on the launch as `legacyLaunchID`. The launch keeps its
container, its contents and its place in space, and the old ID still finds it.
No table is rebuilt.

## Corporation industry output in Corp Deliveries

A corporation industry job whose output was set to the plain "Corporation
Hangars" entry used to file its products under the corporation's office, where
no inventory window shows them. Output now goes to Corp Deliveries at the
station or structure.

Nothing needs doing by hand. When the server starts it moves any products that
were left under an office into Corp Deliveries at the same station or
structure, and it re-points jobs that are still running so they deliver there
too. The log line `office-filed corp deliveries repaired` says how many jobs
and items were moved; it only appears when something was. No table is rebuilt.

## Server nodegraphs and AIR resume

Character records gain optional saved graph/checkpoint, AIR operation, reward
intent and SP receipt fields. `walletAuthorityState` gains permanent nodegraph
pilot and corporation tax receipts. No database rebuild or new player table is
required. The skills table gains `_nodeGraphGrantReceipts` independently of
individual skill records, so extraction cannot erase reward receipts.
Keep characters, wallet authority, items and custody receipts, skills,
corporation runtime, dungeon runtime and
`scheduledJobs` together in backups. Do not delete completed receipts when
pruning stopped graph history. Production startup registers `nodegraph.delay`
and reconciles saved deadlines; changed graph definitions stop the affected root.
Unfinished wallet settlements have independent retry jobs and remain recoverable
after graph stop or skip. Preserve their frozen intents and permanent receipts.

The `evejs.air-tutorial` content pack carries private operation content and no
public spawn family. Normal content-pack installation installs it. Only derived
AIR placeholders can be replaced; an exact client overlay conflict refuses
installation. Existing tutorial eligibility, cinematic mode and skip remain
with their current owners. The AIR consumer implements chapters 1.1–1.5 and
2.1–2.5. Install pack version 1.0.3 for the authored camera targets' site visibility
and the sanitized actor/arrival contracts; older releases remain immutable. No static
database rebuild is needed. New character
AIR fields identify the owned mining instance and original wreck item IDs.
Its `dungeonRuntimeState.spawnState.airMining` stores extraction intents and
actor commands; `miningRockRemainingByID` stores depletion. Preserve those
with items and permanent custody receipts when backing up or restoring.
An interrupted ore grant reconciles before the site becomes playable again.

The optional AIR encounter journal also carries accepted ship/pod death plans,
original deadlines and home-clone/implant receipts. Preserve it together with
items, insurance, killmails, wallet receipts and scheduled jobs in backups.
Production startup resumes accepted losses offline, including after skip,
without killing the replacement hull or repeating settlement. See
[AIR combat](AIR_COMBAT.md). Actual unmodified-client verification is still
required before advertising the complete tutorial as client-compatible.
Chapter 2.2 reuses the installed graph and this pack; no new static data or
database rebuild is needed. Its optional `authoredAirTutorial.economy` records
the original station/ship, prior market activity and original-item retirement
intents. Preserve this character state with permanent custody and wallet
receipts. A replay finishes the original Black Box retirement and interrupted
350,000 ISK settlement without consuming another item or paying twice. See
[AIR economy](AIR_ECONOMY.md).
Fresh encounter and death/handoff have server implementations;
the pack is not evidence of a verified complete native-client tutorial. See
[server nodegraphs and AIR](NODEGRAPH_EXECUTION.md).

Fresh AIR entry now adopts a native capsule from a docked rookie ship, retaining
the original hull and fitting in the hangar. Existing characters whose first
entry failed with `AIR_ENTRY_CAPSULE_REQUIRED` can retry by restarting the game
server and logging in at the station. This requires no player-data reset.

The cavalry follow-up corrects NPC hull types in native slim items and publishes
the authored retrieval/mining wreck IDs. Restart the game server; normal pack
installation selects bundled AIR 1.0.3. Existing saved roots acquire the public
`birth_station_id` and `birth_system_id` aliases on resume. Select the same
character to retry the current task, retaining its original deadlines, items,
checkpoints and receipts. No client patch or database regeneration is needed.

The market daemon now accepts immutable NPC-station metadata from the game
authority during order placement. A missing station catalog row commits with
the order; existing metadata, seed stock, prices and player orders stay intact.
This repairs AIR selling at a station omitted by a market seed preset. Rebuild
and restart the market executable (the native launcher compiles before serving)
or rebuild the Docker image and recreate its market/server containers. Do not
reseed the market for this update. The new capability is
`native-station-metadata-v1`; the additive metadata uses the existing `stations`
table and needs no database rebuild. See [AIR economy](AIR_ECONOMY.md).

## PvP filament event catalog

The release adds the engine-owned static `clientPvpFilaments` table. Normal
startup/updater static synchronization installs the supported historical catalog
without rebuilding player/runtime tables. Manual installers install program
files and restart with normal startup synchronization; rebuilding player data
is unnecessary.
No current event is invented and QA schedules never activate production queues.
Fleet admission is transient, keys remain unconsumed, and arena matches/rewards
remain unavailable. See [PvP filament events and queue](pvp-filament-events-and-queue.md).

## Tow objective component

The release adds the engine-owned static `clientTowComponents` table. Normal
startup/updater static synchronization installs its supported-build subset
without rebuilding runtime data. Build 3396210's original resource and matching
loader verify the two unpublished types; neither becomes player-deployable or
market content. Only explicit server encounter faction context permits native
admission. Relationships and that context remain transient, with no new SQLite
table, persistent deadline or restored towing state. Physical follow and scoring
remain unavailable. See [Tow objective component](tow-objective-component.md).

## Breacher pods

The game store creates the additive ship-owned SQLite runtime table
`breacherPodDeaths` automatically. Existing ship rows gain a validated optional
`spaceState.breacherPodRuntime` budget/terminal-intent record; rows without it
remain compatible. Killmark records gain optional `awardIDs` for accepted death
receipts. Keep these records with characters, items, inventory custody receipts,
insurance operations, killmail event receipts, notifications and `scheduledJobs`
in backups. Retain completed receipts so an interrupted death cannot award or
settle twice. Startup reconciles accepted lethal intents even after capsule
handoff; nonlethal offline budgets pause rather than applying missed damage.
Debris retains its original expiry. No database rebuild or static-data import
is required; install program files only. See [Breacher pods](breacher-pods.md).

## Mobile micro-jump component rules

The release adds the engine-owned static `clientMicroJumpComponents` table.
Normal startup and isolated-test preload reconcile the shipped subset from
`tools/DatabaseCreator/staticTables`; fresh database creation includes it.
No database rebuild or runtime-table migration is needed. Keep existing item
custody and mobile deployment metadata. Historical spool timestamps are retained
but are not resumed after restart; live spools belong to their owning scene.
Install the program files and shipped reference subset. See
[micro-jump-components.md](micro-jump-components.md) for provenance, preserved
gameplay rules and remaining client verification.

## Generic ship-link components

The release adds the engine-owned static `clientShipLinkComponents` table.
Normal startup and isolated-test preload reconcile it from
`tools/DatabaseCreator/staticTables`; fresh database creation includes it.
No runtime table or player-data migration is needed. Keep the current skyhook
sovereignty records, inventory/custody receipts, notifications and scheduled
jobs together in backups. Analysis beacon records retain their existing format
and owner. Install program files and the shipped reference subset; never import
donor databases or world snapshots. See
[generic-ship-links.md](generic-ship-links.md) for cross-build provenance and
remaining client verification.

## Home-station clone self-destruct

Character rows gain an optional `homeStationSelfDestruct` operation journal when
a docked medical-clone death is accepted. Missing fields mean no pending
operation; no table migration or database rebuild is required. Keep characters,
inventory custody receipts, notifications and `scheduledJobs` together in
backups. Startup and character selection resume pending transfers using their
original generation. Keep completed receipts as part of the character record.
Install program files only; never import donor runtime/player data. See
[home-station clone self-destruct](home-station-clone-self-destruct.md).

## Warp bubble drag

Older servers added optional `spaceState.warpState.interdiction` metadata to
inventory ship rows for intercepted warps. The retail Destiny tick no longer
writes or reads it; rows that have it still load. No new table or database
rebuild is required. Keep the current inventory and character data in
backups. Install program files only; do not import donor databases. See
[warp bubble drag](warp-bubble-drag.md).

## Ships saved in warp

A ship that is in warp when the server saves it is now stored stopped at the
point the warp lands, as if the warp had finished, and logs in there. A ship
still aligning had not left and is stored where it is. A warp into a private
site, or out of one, is stored where the ship is, with a
`spaceState.savedWarpLanding` record (the landing point and the destination
instance, room and site); at login the ship goes to the landing point with the
site's tracker when its pilot may be there, and stays where it is otherwise.

Older servers stored a warping ship with mode `WARP` and a
`spaceState.warpState`. Such a row is read the same way: a plain warp loads
stopped at `warpState.targetPoint`, a site warp keeps its destination in
`savedWarpLanding` for login, and the row is rewritten in the new form at its
next save. Before this, an interrupted plain warp logged in stopped at the point
in the middle of the warp where it was last saved. No table migration or
database rebuild is needed.

## Sovereignty structure self-destruct

TCU/Hub countdowns add nullable `selfDestructAt` and
`selfDestructGeneration` fields to existing structure rows. Recovery receipts
live in `structures._meta.structureSelfDestructs` and sovereignty system
`structureDestructionReceipts`; no new table or database rebuild is needed.
Old rows without these fields have no active countdown. Keep these tables,
`scheduledJobs`, inventory grant/custody receipts, asset safety and notifications
together in backups. Boot resumes accepted countdowns even without a pilot and
settles interrupted destruction using its existing generation and outputs.
Retain terminal receipts when a sovereignty mirror is removed. Install program
files only; never import donor player/runtime rows. See
[sovereignty structure self-destruct](sovereignty-structure-self-destruct.md).

## Ship self-destruct

The game store creates the additive, ship-owned SQLite runtime table
`shipSelfDestructs` automatically. Keep its countdown/death records with
`scheduledJobs`, inventory custody receipts, insurance operations, character
state and killmail event receipts when restoring a backup. A missing live pilot
causes an unprepared countdown to cancel on restart; prepared destruction
settles the original death idempotently before completion. New killmail terminal
event receipts live in the existing table's metadata. Existing rows remain
compatible; no database rebuild or donor database import is required. See
[ship self-destruct](ship-self-destruct.md).

## Skyhook reagent raids

Existing sovereignty skyhook rows acquire an additive schema-version-1 `raid`
record when their deployed parent is reconciled. The existing `items` table
holds the silo, raid container, reagent grants and durable custody receipts.
Keep these rows, receipts and `scheduledJobs` together when restoring a backup;
copying only stock or deleting a pending raid receipt can break recovery.
No database rebuild or donor runtime database import is required.

Startup reconciles pending theft settlements and cancels restored links without
their live pilot/scene. Parent generations prevent a replacement skyhook from
inheriting its predecessor's link. Permanent space objects with a null expiry
now survive inventory hydration and expiry cleanup; timed raid containers
retain their two-hour decay deadline after stock commits. See
[skyhook raids](skyhook-raiding.md) for behavior and client verification limits.

## Customs inspection cases

The game store creates `customsInspectionCases` as a security-owned SQLite runtime
table when needed. It records gate arrival identity, law/officer/cargo snapshots,
native dialog decisions, deadlines, and recovery receipts. Existing
`contrabandPenalties` records remain compatible; new case settlements retain
completed receipt records so replay cannot charge the same arrival twice.
Keep both tables when upgrading or restoring a backup.

Detected inventory rows acquire an `inventoryCustodyRevision` on demand. The
inventory owner advances it with custody or quantity changes, in the same write
as the item mutation. Preserve these fields and the penalty's observed revision
and effective confiscation limit when restoring data. An unobserved revision
after interruption makes recovery leave that row untouched unless a committed
custody receipt proves the original removal already occurred. Existing untracked
items and legacy penalty records require no migration.

New installations enable `customsInspectionEnabled` by default. Inspections
require a real validated officer group in the arriving pilot's exact scene;
enabling the feature alone does not manufacture officers. The existing
`npcDefaultConcordStartupEnabled` switch controls the generated CPF gate groups
at the captured Maurasi and Muvolailen gates. The existing Jita formation is
preserved. No donor player data or installed world snapshot is imported.

`customsInspectionScanDelayMs` defaults to 3000 and
`customsInspectionPromptTimeoutSeconds` defaults to 60. The production durable
scheduler recovers unfinished sanctions, accepted confiscations, and dialog
deadlines before opening the game socket. Disabling new inspections does not
discard already persisted cases or their settlement receipts. See
[customs cases](customs-inspection-cases.md) and
[officer authority](customs-operator-authority.md) for behavior and source evidence.

## Gallente election replay migration

The election is opt-in. Fresh configuration has `events.campaignTrailEnabled`
and both `events.eventSchedules` entries disabled. Existing configuration is
preserved by the updater: if you used the prototype, review its enable flags and
set deliberate UTC start/end dates before restarting. The election and login
campaign can be enabled separately under the master switch. See
[event operations](election/OPERATIONS_AND_ACCEPTANCE.md) for a complete example.

The store creates four SQLite runtime tables as needed: `campaignTrailProgress`
(candidate, challenges and claim receipts), `eventLifecycle` (final totals and
deadline acknowledgements), `fwOpenReplay` (FW capture and reward outbox), and
`homefrontReplay` (Homefront-owned completion and recovery records, shared with
the independent Homefront feature). Login reward history and redeem tokens stay
in `newEdenStoreRuntime`. Do not delete these records or reset dates to replay a
claimed season: that can destroy recovery evidence or allow duplicate rewards.

Stop the server and back up the complete configured data root, including
`gameStore/gamestore.sqlite`, its SQLite sidecars, the content-pack registry, and
configuration before upgrading or rolling back. Rollback must restore the code
and matching data/configuration backup together. Disabling an event stops new
progress; committed reward receipts remain recoverable and finalized earned
claims are retained. A new election needs a new season identity and migration.

The retired `evejs.homefront-aid` prototype pack is no longer shipped. If it is
installed, disable/remove it with the content-pack manager before startup; retain
`homefrontReplay` so already-earned prototype payouts can recover. No client
patch is required or supported. Existing Jita, Perimeter and Pakhshi scenery IDs
remain unchanged; this release adds temporary event markers only.


## The updater

### Mandatory offline client migration (19 September 2026)

Before the next client launch, every existing install must pass the new offline
gates. Stop the EveJS client and server, then run `SetupEveJS.bat -Only certs,client-offline`.
The client must be the separate EveJS copy: `start.ini` must say
`server = 127.0.0.1` and `cryptoPack = Placebo`. Setup refuses another install.
It checks every resource-index entry against the local ResFiles folder, applies
the reviewed outbound-endpoint patches and verifies them, rotates the old CA,
and updates the client CA bundles and Windows CurrentUser trust.
Missing resources must come from a complete offline client copy. Play does not
download missing files, install trust or add firewall rules.

The two outbound firewall blocks for the client are a recommended extra and not
part of the mandatory migration. `SetupEveJS.bat -Only firewall` adds them and
needs one UAC approval. See
[The client firewall blocks are recommended, not required](#the-client-firewall-blocks-are-recommended-not-required).

As of 20 September 2026, EveJS no longer serves feature flags. Update the server
and launcher together, restart the server, then quit and restart every client.
Play rejects the old flag-serving server. The removed `config/client-flags.json`
is no longer packaged or read; a stale copy on an existing install has no effect.
The `localChatAuthorityEnabled` setting and its globalConfig entry are removed.
The server deletes the old setting from `config\server.json` the first time it
starts. (Early 0.12.9 beta builds stopped instead with
`unknown setting "presence.localChatAuthorityEnabled"`; on those, delete that
one line from `config\server.json` by hand.) Client code defaults now apply,
including XMPP Local chat and default-off features listed in the
[client flag inventory](OFFLINE_CLIENT_FLAGS.md). This change needs
no additional firewall or certificate-store migration after the controls below
have been installed. Live verification of this revision is pending.

The native flag endpoint patch uses `https://localhost`. The earlier numeric
loopback patch failed initialization in the installed SDK. Play recognizes that
exact earlier hash and upgrades it directly to the verified localhost patch;
unexpected binary changes still stop launch. Releases must include
`launchdarkly_localhost_upgrade_recipe.json` as well as the original-build recipe.

The server now keeps separate DNS-only and numeric gateway leaf certificates.
This fixes the native gateway's TLS validation under the constrained CA. Server
startup generates a missing DNS leaf using the existing valid CA; Setup and Play
check both leaf pairs. After completing the CA migration, this compatibility fix
does not require another root certificate installation or player CA rotation.

The retired CA fingerprint is `BDAC54736BCC544A2C3DC77294905447FD856FD6`.
Its key was once committed. The installer removes that certificate and any
unconstrained `eve.js localhost CA` / `EvEJS Local` root from CurrentUser\\Root,
and removes retired copies from the client bundles. Its replacement is generated
per install, has a new private key, and has critical name constraints for the
intercepted DNS names and `127.0.0.1`. Leaves use an empty subject and a critical
subject-alt-name extension. The CA excludes all nonempty subject names because
Windows otherwise accepts unrelated CN-only certificates, including a second
common name appended after a permitted one. Both Windows SSL policy and OpenSSL
tests now reject those certificates while accepting the allowed SAN-only leaves.
No CA or private key ships in a release.
An existing unconstrained CA cannot be silently reused or rotated by server
startup: the installer must perform this migration first.

For the configured client, these commands install and then check the migration:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\ClientSETUP\scripts\Install-EvEJSCerts.ps1 -RotateCa -ClientPath "D:\EVE Online - 3396210 - Copy\tq"
```

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\ClientSETUP\scripts\Install-EvEJSCerts.ps1 -CheckOnly -ClientPath "D:\EVE Online - 3396210 - Copy\tq"
```

Replace that client path on other machines. Run certificate installation in an
ordinary, visible PowerShell window as the Windows user who plays; CurrentUser
trust belongs to that user. Windows can show **Root Certificate Store** dialogs
for removing the old root and installing the replacement. Review and confirm
those changes, wait for the command to finish, then run `-CheckOnly`. A pending
dialog does not mean migration has passed. The check must
print `Certificate gate passed`. `SetupEveJS.bat -Status` must report the client
offline phase as `[ok]`. Play refuses to launch if that gate fails. The firewall
phase is recommended: it shows `[ok]` when the two blocks are active and `[todo]`
when they are not, and Play warns and starts without them. See
[The recommended firewall blocks](OFFLINE.md#the-recommended-firewall-blocks).

Players using a remote server must receive the host's **new public CA certificate** and
rerun their setup after the host rotates. Never copy the host's CA private key to
a player. Each client needs the same retired-root
removal, constrained-CA verification, endpoint patches, complete-resource check
and launch switches before reconnecting. The firewall blocks are recommended
there too. The local installer
refuses a remote `start.ini`; remote setup must enforce an equivalent identity check.
The firewall helper's `-RemoteServerAddress <literal-IP>` mode is the building
block for that integration: it verifies the exact server IP and Placebo in
`start.ini` and blocks both IPv4 and IPv6 ranges outside loopback and that one IP.
An allow rule cannot override an all-address block. Do not deploy the local
all-address block to a remote player.

Automated constraint tests use temporary CAs and verify allowed and forbidden
certificates in OpenSSL and Windows chain validation without importing any root.
The installed client's native `_ssl.pyd` (OpenSSL 1.1.1g) also passed eight
temporary certificate cases, including outside IPv6 and duplicate common names.
The separate LaunchDarkly library's TLS behavior and the complete login-to-quit
network proof still need the live procedure in [Offline operation](OFFLINE.md).

An EvEJS release is program files only. The release builder copies tracked
files, so a release zip contains no game database, no certificates, no installed
packages and no market database.

Doing the swap by hand means unpacking into a new folder and copying five or six
things across, getting every one of them right, and redoing the client setup
because the certificates were left behind. The updater does it in place instead:

1. Checks the zip is a real EvEJS release and that the target is a real
   installation.
2. Refuses to run while the server is running.
3. Unpacks the new release to a temporary folder, so nothing is touched until
   the whole release is known to be good.
4. Moves the old program files into a dated backup folder inside the
   installation. Files a new release no longer ships are removed this way rather
   than being left behind to confuse the next version.
5. Copies the new release in, leaving your settings files alone.
6. Reinstalls the server packages only if the new release changed them, and on
   Docker rebuilds the image and starts the stack.

Your world, your settings, your certificates and your launcher configuration all
stay where they are the whole time. None of them are copied or rewritten.

**If your installation has no `UpdateEveJS.bat`,** it predates the tool. Ask for
`EvEJS-Updater.zip`, unpack it anywhere — it does not have to go inside your EvEJS
folder — and run `UpdateEveJS.bat` from there. It works exactly the same way.

### Updating to a new release

1. Close the server window and the market server window. On Docker, the updater
   can stop the containers for you.
2. Download the new release zip. Do not unpack it.
3. Run `UpdateEveJS.bat`.
4. Check the folder at the top of the window is your installation. It fills
   itself in when you run it from inside one; otherwise use **Browse**.
5. Next to **The release zip you downloaded**, click **Browse** and pick the file
   you downloaded.
6. The window reports what it found, for example
   *0.12.6 to 0.12.7, native install, 107 files change, 16 new, 1 removed.*
7. Click **Preview** to see exactly what would be moved, kept and replaced
   without changing anything, or click **Update now** to do it.
8. Start the server again and log in before deleting the backup folder.

The updater will not install an older release over a newer one unless you tick
**Allow downgrade**. Reinstalling the version you already have is allowed and is
a reasonable way to repair a damaged installation.

Releases after 0.12.9 are numbered by build date, YYMMDD.n: 261018.1 is the first
build of 18 October 2026. The updater and the content packs treat every dated
release as newer than 0.12.9, so updating from 0.12.9 is a normal update.

### Content packs

The updater does not touch them. Every release ships its packs in the
`content-packs` folder and the server installs whatever is in there when it
starts, so an update brings the new packs with it and the next start puts them
in place. To run without one, delete its file from that folder. See
[Installing and removing content packs](CONTENT_PACKS.md).

### The one-time sovereignty reset

The server supports only today's retail sovereignty: the Sovereignty Hub is the
only sovereignty structure, and a claimed Hub is the claim. Sovereignty data
from earlier releases is not repaired. After the files are in place, the updater
runs `tools\Maintenance\reset-sovereignty.js` once (on Docker,
`docker compose run --rm --no-deps maintenance reset-sovereignty`). It backs
the game database up to `_local\backups\sov-parity-reset-<time>\` (on Docker,
`/var/lib/evejs/backups/` inside the `evejs-data` volume), then removes every
claim, Hub with its upgrades and fuel, command node and campaign, alliance prime
hour and capital setting, development index, Skyhook, Mercenary Den and FLEX
structure, with everything stored in them. It records a marker in the game
database, and later updates see the marker and do nothing.

The server runs the same reset itself when it starts and finds no marker, so
if the updater could not run it (Node.js not on PATH, or the tool failed), the
next start does it: it makes the same backup, removes the same data and logs
what it removed. If the reset fails, the server does not start, and the log
says where the backup went.

To run it by hand instead, stop the server and run it from the installation
folder:

```
node tools\Maintenance\reset-sovereignty.js
```

Add `--dry-run` to see what it would remove without changing anything. To stop
the server from running it, set `sovereignty.sovereigntyOneTimeParityReset` to
`false` in `config\gameplay.json`; the server then only warns at every start
while old sovereignty data is present.

### Server logs moved to `_local\logs`

The server now writes its logs and Node diagnostic reports to `_local\logs`
instead of `server\logs`, so nothing it writes while running lands among the
program files. (If `EVEJS_DATA_ROOT` is set, they go to its `logs` folder.) The
first time the new version starts, it moves everything in `server\logs` into
`_local\logs` and says so in the log. A file that `_local\logs` already has
under the same name is never overwritten: it stays in `server\logs`, the log
says how many were left, and you can delete or keep them as you like.

On Docker the logs are at `/var/lib/evejs/logs` in the container. The shipped
`compose.yaml` mounts the `evejs-logs` volume there, so the logs you already
have carry over. If you run your own compose file that mounts `evejs-logs` at
`/app/server/logs`, change that mount to `/var/lib/evejs/logs`.

To file an error report, `tools\ErrorReport\error-report.ps1` looks in the new
place first and falls back to `server\logs` for an install that has not started
since the move.

### Old log archives are deleted after 7 days

The server writes about 25 separate logs (`server.log`, `inventory-debug.log`
and so on) and starts a new archive file for each one every hour. Until now
nothing deleted those archives, and a busy server could fill tens of gigabytes
a week.

Each log now keeps the archives of its newest 168 hours (7 days), and its older
archives are deleted. Each log is counted on its own, so a log that writes only
now and then keeps its last 168 hours however long ago they were. The cleanup
runs when the server starts and then every hour. The file currently being
written is never deleted, and neither is anything else in the logs folder.

The first start after updating can delete a lot at once, and the log says how
many archives and bytes it removed. To keep a different amount, set
`logRetentionHours` in the `logging` section of `config\server.json`, or the
`EVEJS_LOG_RETENTION_HOURS` environment variable for Docker. `0` keeps every
archive, as before. Copy anything you want to keep out of `_local\logs` before
you start the new version.

On Docker Desktop for Windows, deleting files inside a volume does not shrink
the WSL disk image on its own; compact it once (`diskpart`, then
`compact vdisk`) to give the space back to Windows.

### Certificates moved to `_local\certs`

As of 21 September 2026 the server keeps its certificates and keys in
`_local\certs` instead of `server\certs` and
`server\src\_secondary\express\certs`. That is the local CA your client trusts,
the chat server's certificate and the public gateway's certificates. (If
`EVEJS_DATA_ROOT` is set, they go to its `certs` folder.)

The CA itself does not change. The first time the new version needs a
certificate, the server copies the files from the two old folders into
`_local\certs` and says so in the log, so your client keeps trusting the same
CA. It copies rather than moves, and it never overwrites a file `_local\certs`
already has. The old files stay where they were, so an older version still
finds them if you go back to it; nothing in this version reads them after the
copy.

After updating, stop the server and run the setup once, so its checks look in
the new place:

```
SetupEveJS.bat -Only certs,client-offline
```

It makes the same copy if the server has not made it yet, then checks the
certificates and the client's trust. `Play.bat` switches by itself: launcher
settings that still name `server\certs\xmpp-ca-cert.pem` use the file in
`_local\certs` once it is there.

On Docker, the shipped `compose.yaml` mounts `_local\certs` as the container's
certificate folder and the two old folders read only, so the container copies
an existing CA across the same way. If you run your own compose file, add the
`./_local/certs:/var/lib/evejs/certs` mount.

### The client firewall blocks are recommended, not required

By the owner's decision of 6 October 2026, the two Windows Firewall blocks for
the EveJS client no longer stop Play. From the next release, Play warns when
they are not active and starts anyway, and Setup offers them without failing
when you say no.

Blocks you already installed stay in place and keep working; an update does
not touch them. To remove them, run this in an elevated PowerShell window. It
removes every block EveJS added on this computer:

```
Get-NetFirewallRule -Group EveJS | Remove-NetFirewallRule
```

`EVEJS_FIREWALL_GATE` in `tools\ClientSETUP\scripts\EvEJSConfig.bat` now
defaults to `warn`. A line that already says `warn` keeps working and is no
longer needed. The updater keeps that file, so one made by an earlier release
may still carry a comment saying Play refuses to start without Windows
Firewall. That comment is out of date and can be deleted. To make Play refuse
to start without the blocks, as it did before, set the value to `enforce`:

```
set "EVEJS_FIREWALL_GATE=enforce"
```

To add the blocks later, run `SetupEveJS.bat -Only firewall`. See
[The recommended firewall blocks](OFFLINE.md#the-recommended-firewall-blocks).

### Moon mining and the moon composition pack

Survey probes, refineries and the Metenox Moon Drill read each moon's ores from
the moon composition pack, `moon-compositions.json` in the game database folder
(`_local\gameStore\` on Windows). Nothing else changes in your data:

- A refinery or Metenox is tied to its moon when it starts anchoring. One that
  was anchored before this release is tied, and given its ores, the first time
  someone opens its extraction or drill window.
- Fractured chunks leave their ore fields in a new table, `moonMiningFields`,
  which the server creates on its own.
- The first start after the pack changes writes a small cache beside it,
  `moon-compositions.index.bin`, so later starts read the pack in milliseconds.

Without a pack, surveys report nothing and moon mining stays off. A release
does not include a pack; each install makes its own. To make it, or to
regenerate it when the server log says it is out of date, stop the server, run
this from the installation folder, then start the server again:

```
node tools\moon-data\generate-moon-composition-pack.js --out _local\gameStore\moon-compositions.json --force
```

This uses the project's default seed, `EveJS`. If your install was made with a
seed of its own, run `set EVEJS_MOON_WORLD_SEED=<that seed>` first, or every
moon gets different ores.

`--force` keeps a backup of the old pack in `_local\backups\moon-data\`.
Refineries and Metenoxes pick up the new ores the next time they are used;
extractions already running keep what they started with.

### The backup folder

Old program files are moved, not deleted. They land in

```
_backup\pre-update-<old version>-<date>-<time>\
```

inside the installation, keeping their original layout, alongside `update.log`
and a `manifest.json` describing what was moved and what was kept. A release is
about 200 MB, so expect the backup to use roughly that much until you remove it.

The updater offers to delete it at the end. Say no until you have started the
server and logged in. `_backup\` is excluded from Git and from the Docker build
context, so leaving it in place breaks nothing.

If the copy fails part way through, the updater puts the backup back and tells
you the installation was left as it was.

### When something goes wrong

Every run writes a log to `%TEMP%\EvEJS-Updater\`, and a copy goes into the
backup folder. **Save log** in the window copies it somewhere you can attach to a
bug report.

- *"That folder is not an EvEJS installation."* The folder must contain
  `server\index.js` and `StartServer.bat`. Pick the folder that has
  `StartServer.bat` in it, not its parent and not a subfolder.
- *"That zip is not an EvEJS release."* The zip must contain `server/index.js`
  and `config/version.json`. A zip of only the content packs, or of a subfolder,
  will not work.
- *"The server is still running."* Close the server window, or on Docker let the
  updater run `docker compose down` for you. Docker volumes are never removed.
- *"npm was not found."* The packages were not reinstalled. `StartServer.bat`
  installs them the next time it starts.
- The window never appears at all: run `UpdateEveJS.bat /console`, which keeps
  the console visible so the error is readable.
- Antivirus can hold a file open long enough for a move to fail. The updater
  retries; if it still fails it restores the backup and stops.

## What is kept and what is replaced

Homefront Operations adds a `homefrontReplay` table to the existing game database
for active encounters and pending payouts. Keep it with the rest of
`_local\gameStore\`; startup migrates the earlier `/state` format automatically
and prunes settled encounters without discarding unpaid rewards. Site density is
configured in `config/world.json`; see [Homefront settings](HOMEFRONT_OPERATIONS_IMPLEMENTATION_STATUS.md#running-this-branch).

This is what the updater does, and it is also the checklist the manual path is
working from. The full list lives in `tools\Updater\update-policy.json`, and a
test keeps it in step with `.gitignore`, `compose.yaml` and the release builder.

**Kept, never touched**

| Path | What it holds |
|---|---|
| `_local\` | the game database, characters, portraits, alliance logos, cached static data, installed content packs, server logs (`_local\logs\`) and this machine's certificates (`_local\certs\`) |
| `externalservices\market-server\data\` | the market database and its retained backups |
| `externalservices\market-server\target\`, `tools\market-seed*\target\` | compiled Rust binaries, so the market does not need rebuilding |
| `tools\market-seederv2\cache\`, `tools\market-seederv3\cache\` | downloaded market snapshots |
| `node_modules\`, `server\node_modules\` | installed packages, unless the release changed them |
| `server\certs\`, `server\src\_secondary\express\certs\` | certificates from releases before they moved to `_local\certs\`; the server copies them there on its first start |
| `tools\ClientSETUP\scripts\EvEJSConfig.bat` | your launcher configuration |
| `.env` | Docker ports and the web gateway token |
| `server\src\_secondary\image\generated\Alliance\`, `...\Character\` | imported alliance logos and older uploaded portraits |
| `server\logs\`, `logs\` | server logs from releases before logs moved to `_local\logs\`; the server moves them there on its first start |
| `evejs.config.json`, `evejs.config.local.json` | a pre-schema installation's settings, kept so the new version can migrate them |

**Kept, but new settings are added to them**

`config\server.json`, `gameplay.json`, `world.json`, `mining.json`, `npc.json`
and `economy.json` are your settings and are never overwritten. When a release
adds a setting, the server writes it into your file with its default value the
next time it starts, so your host, ports and gameplay choices survive an update
untouched. When a release retires a setting, the server removes it from your
file the same way. `config\version.json` is the one config file the updater does
replace; it records which release is installed.

**Replaced**

The program files: `server\src\`, `tools\`, `doc\`, `docker\`, the launchers, and
the rest of what a release ships.

**Left where they are**

Anything that is not part of a release. Installations collect things — a
community tool under `tools\`, notes at the top level, a pack file you
downloaded — and none of that is the updater's to move. It reports how many such
files it found and names the folders.

Working out which is which is exact from the second update onwards: each update
records what it installed in `.evejs-installed-files.json`, so the next one knows
precisely which files a new release dropped. On the very first update there is no
such record, so it falls back to the folder: a stray file in a folder the release
fills (`server\src\services\dungeon\`) is treated as a leftover, while a folder
the release knows nothing about (`tools\YourTool\`) is left alone. The
installation root counts as unknown, because you keep things there too.

**Refused**

The updater stops instead of running if the folder contains a `.git` directory,
because that is a source checkout and should be updated with Git. It also stops
if the server is still running.

It stops as well if it finds `server\src\gameStore\gamestore.sqlite` — a world in
the source tree rather than in `_local\`. `StartServer.bat` reads `_local`, so
updating around that world would leave it stranded and you would log in to an
empty universe. Move that file, and any `-wal` and `-shm` file beside it, into
`_local\gameStore\` first.

Generated tables under `server\src\gameStore\data\` are *not* a reason to stop.
An installation with no `_local` writes tables like `newEdenStore` there just by
running an editor; they are kept where they are.

## Updating by hand

Use the manual path when:

- You are **moving to another PC** or deliberately want the new version in a
  different folder. The updater only updates in place.
- Your Docker host is **not Windows**. The updater is a Windows program; the
  manual Docker steps work anywhere.
- You want to **keep the old installation exactly as it is** so you can go back
  to it by running the old folder.
- The updater **refuses your folder** — a Git checkout, or a game database found
  in the source tree. Both refusals are deliberate; read the message before
  working around it.
- You are **scripting a deployment** and want explicit commands.

The idea is the same either way: unpack the new version, then bring your data to
it. What to bring is the *Kept* table above.

### By hand: native Windows

1. Close the server window and the market server window.
2. Unpack the new version into a **new folder** next to the old one.
3. Copy these from the old folder into the same locations in the new folder:
   - `_local\gameStore\` — the world. Nothing else matters as much as this one.
   - `externalservices\market-server\data\generated\` — the market database.
   - `config\` — your server settings. The new version adds any settings it has
     gained to these files the first time it starts.
   - `.env`, if you made one.
   - `tools\ClientSETUP\scripts\EvEJSConfig.bat` — your launcher configuration.
     Copying it saves rerunning the client wizard for the launcher settings.
   - `_local\certs\` — this machine's certificates. Without them the client
     setup wizard has to be rerun so the new certificates are trusted. An
     installation from before 21 September 2026 has them in `server\certs\`
     and `server\src\_secondary\express\certs\` instead: copy the `.pem`,
     `.pfx`, `.key` and passphrase files from those into the same folders, and
     the new version copies them into `_local\certs\` when it starts.
   - for an older installation that has no `config\` yet, its
     `evejs.config.local.json` migration input.
   - `server\src\_secondary\image\generated\Character\` — only if the old version
     has this folder. See [Older installations](#older-installations).
4. Optionally copy `server\node_modules\` and
   `externalservices\market-server\target\` as well. Neither is required — they
   are rebuilt on demand — but copying them saves an `npm ci` and a long Rust
   build. If the release changed its dependencies, delete
   `server\node_modules\` instead and let `StartServer.bat` reinstall.
5. Nothing to do for the one-time sovereignty reset: the server runs it at its
   first start in the new folder, and it does nothing if the old installation
   already ran it. See
   [The one-time sovereignty reset](#the-one-time-sovereignty-reset).
6. Run `StartMarketServer.bat`, then `StartServer.bat`, in the new folder.

Keep the old folder until you have logged in and confirmed your characters, ships
and portraits are all present.

### By hand: Docker

Docker keeps the world in the named volumes `evejs-data` and `evejs-logs`.
Volumes are found by name rather than by folder, so the install folder can be
replaced freely. What lives in the folder and must be carried across is `config/`,
the certificates in `_local/certs/` and, if you customised it, `.env`.

If the old version stored portraits in the program files, rescue them **first**,
in the old install folder, while its containers still exist — `docker compose
down` deletes them:

```
docker compose cp server:/app/server/src/_secondary/image/generated/Character ./portrait-rescue
docker run --rm -v evejs-data:/data -v "${PWD}/portrait-rescue:/src" alpine sh -c "mkdir -p /data/gameStore/images/Character && cp -a /src/. /data/gameStore/images/Character/ && chown -R 1000:1000 /data/gameStore/images"
```

If that first command reports no such file or directory, the old containers had
no uploaded portraits and there is nothing to rescue.

When upgrading from a version that did not yet mount `evejs-logs`, also rescue
the old container-only diagnostics before replacement if you need them for an
incident review:

```powershell
docker compose cp server:/app/server/logs ./pre-upgrade-server-logs
```

New deployments keep subsequent logs in `evejs-logs`, so later rebuilds and
container replacements do not require this rescue step.

Now stop everything cleanly, still in the old install folder:

```
docker compose down
```

> **Never add `--volumes` when upgrading.** `docker compose down --volumes`
> deletes `evejs-data` and `evejs-logs`, including every account, character,
> market order, and retained server diagnostic.

Then unpack the new version — a new folder is fine. Copy `config/`,
`_local/certs/` and any custom `.env` from the old folder into it before
starting. An installation from before 21 September 2026 has its certificates in
`server/certs/` and `server/src/_secondary/express/certs/` instead: copy the
`.pem`, `.pfx`, `.key` and passphrase files from those into the same folders,
and the server copies them into `_local/certs/` when it starts.

On a Linux host, create `_local/certs` yourself before the first start and give
it to the container's user. If it is missing, Docker creates it owned by root,
and the server, which runs as user 1000, cannot write its certificates there:

```
mkdir -p _local/certs && sudo chown 1000:1000 _local/certs
```

Validate and start the new version:

```powershell
docker compose config --quiet
docker compose build
docker compose up -d
```

Check that your characters are there before deleting the old folder.

### Older installations

**From a version released before 25 July 2026.** Uploaded character portraits
used to be written into the program files, at
`server\src\_secondary\image\generated\Character`. That is why they were left
behind whenever an install was copied to a new folder, and why rebuilding a
Docker container erased them. They now live in `_local\gameStore\images`, beside
the game database, so they travel with everything else. The server keeps reading
the old location in the meantime, so nothing breaks if you update first and
migrate later. To move them by hand at any time, run this from the `server`
folder:

```powershell
npm run images:migrate
```

Add `-- --dry-run` to see what it would move without changing anything.

**From a version released before 18 September 2026.** Regenerating the moon
composition pack with `--force` used to leave a timestamped copy of the old pack
(about 100 MB each) beside it, as `moon-compositions.json.bak-*`, and never
removed them. It now moves them into `_local\backups\moon-data` and keeps the
newest three. Old copies beside your pack are not moved for you; delete them, or
move them into that folder if you want to keep them.

**From a version that predates the local SQLite runtime store.**
`StartServer.bat` migrates the legacy data automatically and leaves the original
files untouched. To run that migration by hand, use `npm run db:migrate-legacy`
from the `server` folder.

**From a pre-schema release that has only `evejs.config.local.json`.** Keep that
file: both the updater and the manual path carry it across, and the new server
migrates its values into the `config\` files on the first start, then archives it
into `_local\config-backups`.

On Docker, build the new image, copy that legacy file beside the new
`compose.yaml`, and run this one-time migration before `docker compose up`:

```powershell
docker compose run --rm --no-deps `
  --volume "${PWD}/evejs.config.local.json:/app/evejs.config.local.json:ro" `
  server node -e "require('/app/server/src/config').initializeConfigFiles({ archiveLegacy: false })"
```

The command overlays the legacy values onto the new host-mounted `config/`
files. Keep the original monolith with the old installation as your migration
backup; Docker does not need it again after the generated domain files have been
reviewed.

## Moving to another PC

That is not an update, and the updater does not do it. See
[Moving a server to another PC](SETUP.md#moving-a-server-to-another-pc).

## Career progress and queued rewards

The career infrastructure adds character-owned `careerProgramProgress`, a
completion timestamp on newly earned authored AIR tutorial receipts, and
account-owned `careerProgramClaims` in `newEdenStoreRuntime`. A career claim and
its redeem tokens share one durable account checkpoint. Existing characters are
not deemed eligible merely because their AIR state is already completed. The
shipping catalog uses verified localization with explicitly EveJS-authored
identities, points and rewards. No donor player state is imported.

Back up `characters`, `newEdenStoreRuntime`, inventory/custody receipts, wallet
authority and scheduled jobs together. Restoring only claim history or only the
reward queue can separate accepted rewards from their durable fulfillment.
Older versions may discard fields they do not understand when rewriting accounts;
keep a complete backup before downgrading. See [career scope](AIR_CAREER_PROGRAM.md).

## ESS runtime banks (2026-10-22)

`dynamicResourceRuntime` is a new SQLite runtime table, owned by `service:dynamic`.
It is created empty on first use; never copy donor bank/runtime files into it.
Existing pending NPC bounty records without an ESS split keep their original
full payout. New records persist a frozen split and completed source-event
receipts. Back up the complete gameStore before downgrading; older binaries do
not understand ESS settlement intents or the pending-record funding fields.
See [ESS banks](ESS.md).

ESS reserve windows now persist exact cargo-key intents and item-custody
receipts in the same runtime table. No static install or donor file is needed.
An existing public authored ESS is discovered from its live scene on native
query or NPC destruction. Windows retain their original wall-clock deadline
across restarts. Back up inventory and ESS runtime state together; restoring
only one can separate a consumed key from its accepted window.

DBS adds per-system activation watermarks, period inputs and loss receipts to
`dynamicResourceRuntime`, and server-only `dbsInputAtMs` metadata to newly
committed qualifying killmails. Existing losses are not backfilled when a
system first activates. The normal startup/daily recovery scan consumes only
new committed losses beyond that activation watermark. No donor or client
runtime data needs to be installed. Preserve the ESS table, killmails,
pending bounties, inventory and wallet authority together in backups.

## Content-pack validation receipts (2026-10-26)

Loading content packs now keeps a small derived cache,
`content-packs/validated.json`, beside `installed.json`. It records, for each pack
file's exact bytes, the result of validating it, together with a fingerprint of
the engine version and the validating code, so later startups skip the slow
re-validation of unchanged packs. It holds nothing that cannot be rebuilt: if it
is missing, unreadable or from another version, every pack is simply validated
again on the next start and the file is rewritten. There is nothing to migrate,
and backups and restores may include or leave out the file.
