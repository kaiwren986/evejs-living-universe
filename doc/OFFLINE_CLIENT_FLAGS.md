# Client flags for offline EveJS

Inventory read on 2026-09-19 from client build 3396210 under
`tools/ClientCodeGrabber/Latest`. These are client code defaults, not a claim about the
values CCP served. No outside service was queried.

There are 67 distinct fixed keys in the `featuremanagement.client.flag` callers examined.
The scan found 68 call sites, including repeated keys and two dynamic callers. The wallet
caller resolves to three additional fixed keys through its subclasses. The nodegraph
caller remains data-dependent, so this is not a claim that runtime content has only 67 flags.

## Supported local UI flags and built-in defaults

On 2026-09-20 the owner replaced the earlier feature profile with client defaults.
On 2026-10-23 the owner enabled the achievement UI for in-game testing. EveJS
serves its achievement/title evaluations from existing loopback endpoints. The
local Aura guidance port adds one more, for exactly three boolean evaluations:
`achievements_feature_enabled: true`, `character_titles_feature_enabled: true`
and `eve_ag_guidance_enabled: true`.
The title flag exposes the titles earned from achievement rewards. Polling and
native `put` event streams use the same fixed set; event uploads are discarded.
All other keys remain absent and use their client defaults. There is no profile
file or arbitrary flag override mechanism.

The native endpoint patch remains mandatory. The two firewall blocks are
[recommended, not required](OFFLINE.md#the-recommended-firewall-blocks). Requests to the patched
loopback evaluation paths receive the local set; real LaunchDarkly destinations stay
blocked without DNS resolution by the proxy.

The table below describes the values supplied by the client callers when no flag
value is available. In particular, `eve-local-chat-authority` defaults to `false`,
selecting the older XMPP Local-chat path. New character creation retains its
default. The table records code defaults, so the achievement, title and Aura
guidance rows still say `false` despite the three local evaluations above.
Existing clients must quit and restart; an already
running SDK can retain values received before the server update.

The old policy file remains ignored. Play verifies version 4 health on both
HTTP and trusted HTTPS, requiring forwarding disabled, profile
`local-supported-features` and exactly the three true values. See
[achievement coverage](ACHIEVEMENTS.md) and [local Aura guidance](AURA_GUIDANCE.md).

## Fixed keys

Source links identify a read or registration under the decompiled client. Names and defaults
supplied by constants were resolved from the caller's imports. Wallet subclasses supply
the three donation keys to `DonateLPPanel._init_killswitch`.

| Flag key | Type | Code default | Feature | Client source |
| --- | --- | --- | --- | --- |
| `a_a_test_flag` | bool | `false` | Aura guidance A/A experiment callback. | [auraguidance/client/feature_flags.py:10](../tools/ClientCodeGrabber/Latest/auraguidance/client/feature_flags.py#L10) |
| `achievements_feature_enabled` | bool | `false` | Achievements feature. | [achievement_system/client/api/feature_flag.py:8](../tools/ClientCodeGrabber/Latest/achievement_system/client/api/feature_flag.py#L8) |
| `air_career_program_progression_claiming_enabled` | bool | `true` | AIR Career Program progression reward claiming. | [careergoals/client/feature_flag.py:8](../tools/ClientCodeGrabber/Latest/careergoals/client/feature_flag.py#L8) |
| `are_heraldry_agents_enabled` | bool | `true` | Heraldry agent availability. | [eve/client/script/ui/station/agents/agents.py:351](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/station/agents/agents.py#L351) |
| `autoplay_boarding_moment` | bool | `true` | Automatically play a first-time ship boarding moment. | [shipprogression/boarding_moment/feature_flags.py:7](../tools/ClientCodeGrabber/Latest/shipprogression/boarding_moment/feature_flags.py#L7) |
| `campaigns_client_live_updates_polling_frequency` | int | `30` | Campaign update polling interval. | [campaigns/client/feature_flags.py:9](../tools/ClientCodeGrabber/Latest/campaigns/client/feature_flags.py#L9) |
| `campaigns_feature_enabled` | bool | `true` | Campaign feature. | [campaigns/client/feature_flags.py:8](../tools/ClientCodeGrabber/Latest/campaigns/client/feature_flags.py#L8) |
| `character_titles_feature_enabled` | bool | `false` | Character title feature. | [cosmetics/client/character/title/api/feature_flag.py:8](../tools/ClientCodeGrabber/Latest/cosmetics/client/character/title/api/feature_flag.py#L8) |
| `client-notice-consumer-amount-of-notices-to-consume-at-once` | int | `100` | Maximum public gateway notices consumed in one batch. | [publicGateway/grpc/noticeConsumer.py:31](../tools/ClientCodeGrabber/Latest/publicGateway/grpc/noticeConsumer.py#L31) |
| `client-secure-url-string-flag` | string | `'https://secure.eveonline.com'` | External EVE account URL. Offline service must replace it with loopback. | [eve/common/script/util/urlUtil.py:11](../tools/ClientCodeGrabber/Latest/eve/common/script/util/urlUtil.py#L11) |
| `client-ship-skinr-feature-enabled` | bool | `true` | Ship SKINR feature. | [cosmetics/client/ships/feature_flag.py:8](../tools/ClientCodeGrabber/Latest/cosmetics/client/ships/feature_flag.py#L8) |
| `client-store-url-string-flag` | string | `'https://store.eveonline.com'` | External EVE store URL. Offline service must replace it with loopback. | [eve/common/script/util/urlUtil.py:10](../tools/ClientCodeGrabber/Latest/eve/common/script/util/urlUtil.py#L10) |
| `corp-goals-enabled-feature-flag` | bool | `true` | Corporation goals. | [corporation/client/goals/featureFlag.py:8](../tools/ClientCodeGrabber/Latest/corporation/client/goals/featureFlag.py#L8) |
| `corporation_palettes_enabled` | bool | `true` | Corporation color palettes. | [corporation/client/colors/feature_flags.py:8](../tools/ClientCodeGrabber/Latest/corporation/client/colors/feature_flags.py#L8) |
| `daily-goal-payment-enabled-feature-flag` | bool | `true` | Daily goal rewards. | [dailygoals/client/featureFlag.py:9](../tools/ClientCodeGrabber/Latest/dailygoals/client/featureFlag.py#L9) |
| `daily-goals-enabled-feature-flag` | bool | `true` | Daily goals. | [dailygoals/client/featureFlag.py:8](../tools/ClientCodeGrabber/Latest/dailygoals/client/featureFlag.py#L8) |
| `default-overview-offer-update` | bool | `false` | Offer an update to the default overview. | [eve/client/script/parklife/overview/default/informer.py:22](../tools/ClientCodeGrabber/Latest/eve/client/script/parklife/overview/default/informer.py#L22) |
| `disable-all-ship-emblems` | bool | `false` | Kill switch for all ship emblems; false allows them. | [cosmetics/client/shipLogoController.py:21](../tools/ClientCodeGrabber/Latest/cosmetics/client/shipLogoController.py#L21) |
| `enable_new_character_creation` | bool | `false` | New character creation flow. | [eve/client/script/ui/login/feature_flag.py:7](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/login/feature_flag.py#L7) |
| `eve-desktop-client-request-tracing-sample-rate` | int | `1000` | Public gateway request tracing sample rate. | [publicGateway/grpc/spanManager.py:31](../tools/ClientCodeGrabber/Latest/publicGateway/grpc/spanManager.py#L31) |
| `eve-local-chat-authority` | bool | `false` | Local chat through the public gateway; false uses the older XMPP path. | [chat/client/chat_service.py:42](../tools/ClientCodeGrabber/Latest/chat/client/chat_service.py#L42) |
| `eve-new-eden-store-shortcut-in-neocom` | bool | `true` | New Eden Store shortcut in the Neocom. | [eve/client/script/ui/view/aurumstore/specialNeocomButton.py:17](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/view/aurumstore/specialNeocomButton.py#L17) |
| `eve_ag_guidance_added_to_segment` | bool | `false` | Include this user in the Aura guidance segment. | [auraguidance/client/feature_flags.py:9](../tools/ClientCodeGrabber/Latest/auraguidance/client/feature_flags.py#L9) |
| `eve_ag_guidance_enabled` | bool | `false` | Aura guidance availability. | [auraguidance/client/feature_flags.py:8](../tools/ClientCodeGrabber/Latest/auraguidance/client/feature_flags.py#L8) |
| `eve_client_hostile_network_exception_reporting` | json | `JSON; see below` | Classify network exceptions by exception name, ASN and country for Sentry filtering. | [monolithsentry/client/hostile_exceptions.py:24](../tools/ClientCodeGrabber/Latest/monolithsentry/client/hostile_exceptions.py#L24) |
| `freelance_projects_client_live_updates_polling_frequency` | int | `30` | Freelance project update polling interval. | [freelanceprojects/client/feature_flags.py:9](../tools/ClientCodeGrabber/Latest/freelanceprojects/client/feature_flags.py#L9) |
| `freelance_projects_enabled_feature_flag` | bool | `true` | Freelance project UI and updates. | [freelanceprojects/client/feature_flags.py:8](../tools/ClientCodeGrabber/Latest/freelanceprojects/client/feature_flags.py#L8) |
| `freelance_projects_enabled_in_air_opportunities_feature_flag` | bool | `true` | Freelance projects in AIR Opportunities. | [jobboard/client/feature_flag.py:20](../tools/ClientCodeGrabber/Latest/jobboard/client/feature_flag.py#L20) |
| `global_plex_market_experiment_enabled` | bool | `false` | Global PLEX market experiment. | [marketutil/feature_flags/client/__init__.py:9](../tools/ClientCodeGrabber/Latest/marketutil/feature_flags/client/__init__.py#L9) |
| `goal-payment-enabled-feature-flag` | bool | `true` | Corporation goal payments. | [corporation/client/goals/featureFlag.py:9](../tools/ClientCodeGrabber/Latest/corporation/client/goals/featureFlag.py#L9) |
| `heraldry-disable-all-corp-lp-store-purchases` | bool | `false` | Kill switch for corporation LP store purchases; false allows purchases. | [eve/client/script/ui/station/loyaltyPointStore/lpStoreSvc.py:58](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/station/loyaltyPointStore/lpStoreSvc.py#L58) |
| `heraldry-disable-all-player-lp-donations` | bool | `false` | Kill switch for personal LP donations; false allows donations. | [eve/client/script/ui/shared/neocom/wallet/panels/personal/personalDonateLPPanel.py:14](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/shared/neocom/wallet/panels/personal/personalDonateLPPanel.py#L14) |
| `heraldry-disable-all-transfers-from-corp-lp-wallet` | bool | `false` | Kill switch for corporation LP wallet donations; false allows donations. | [eve/client/script/ui/shared/neocom/wallet/panels/corp/corpDonateLPPanel.py:15](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/shared/neocom/wallet/panels/corp/corpDonateLPPanel.py#L15) |
| `heraldry-disable-em-donations` | bool | `false` | Kill switch for personal/corporation EverMarks donations; false allows donations. | [eve/client/script/ui/shared/neocom/wallet/panels/personal/personalDonateEMPanel.py:25](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/shared/neocom/wallet/panels/personal/personalDonateEMPanel.py#L25) |
| `heraldry-disable-structure-paintworks-and-skinr` | bool | `false` | Kill switch for structure paintworks and SKINR; false allows them. | [eve/client/script/ui/cosmetics/structure/paintToolWnd.py:37](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/cosmetics/structure/paintToolWnd.py#L37) |
| `heraldry-minimum-alliance-membership-duration-for-em-donations` | int | `30` | Minimum alliance membership duration for EverMarks donations, in days. | [eve/client/script/ui/shared/neocom/wallet/panels/corp/corpDonateEMPanel.py:27](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/shared/neocom/wallet/panels/corp/corpDonateEMPanel.py#L27) |
| `is-new-eden-store-intro-enabled` | bool | `true` | Show the New Eden Store introduction. | [storylines/client/nes_intro.py:53](../tools/ClientCodeGrabber/Latest/storylines/client/nes_intro.py#L53) |
| `is_starting_in_starter_space_enabled` | bool | `true` | Starting new characters in starter space. | [charactercreator/client/feature_flags.py:8](../tools/ClientCodeGrabber/Latest/charactercreator/client/feature_flags.py#L8) |
| `job-board-combat-anomalies-enabled-feature-flag` | bool | `true` | Show combat anomalies in the job board. | [jobboard/client/feature_flag.py:11](../tools/ClientCodeGrabber/Latest/jobboard/client/feature_flag.py#L11) |
| `job-board-dungeons-enabled-feature-flag` | bool | `true` | Show dungeons in the job board. | [jobboard/client/feature_flag.py:10](../tools/ClientCodeGrabber/Latest/jobboard/client/feature_flag.py#L10) |
| `job-board-enabled-feature-flag` | bool | `true` | AIR Opportunities job board. | [jobboard/client/feature_flag.py:8](../tools/ClientCodeGrabber/Latest/jobboard/client/feature_flag.py#L8) |
| `job-board-escalation-sites-enabled-feature-flag` | bool | `true` | Show escalations in the job board. | [jobboard/client/feature_flag.py:16](../tools/ClientCodeGrabber/Latest/jobboard/client/feature_flag.py#L16) |
| `job-board-factional-warfare-enabled-feature-flag` | bool | `true` | Show Factional Warfare sites in the job board. | [jobboard/client/feature_flag.py:15](../tools/ClientCodeGrabber/Latest/jobboard/client/feature_flag.py#L15) |
| `job-board-goals-enabled-feature-flag` | bool | `true` | Show goals in the job board. | [jobboard/client/feature_flag.py:14](../tools/ClientCodeGrabber/Latest/jobboard/client/feature_flag.py#L14) |
| `job-board-homefront-operations-enabled-feature-flag` | bool | `true` | Show Homefront Operations in the job board. | [jobboard/client/feature_flag.py:12](../tools/ClientCodeGrabber/Latest/jobboard/client/feature_flag.py#L12) |
| `job-board-ice-belts-enabled-feature-flag` | bool | `true` | Show ice belts in the job board. | [jobboard/client/feature_flag.py:18](../tools/ClientCodeGrabber/Latest/jobboard/client/feature_flag.py#L18) |
| `job-board-missions-enabled-feature-flag` | bool | `true` | Show missions in the job board. | [jobboard/client/feature_flag.py:13](../tools/ClientCodeGrabber/Latest/jobboard/client/feature_flag.py#L13) |
| `job-board-open-on-startup-feature-flag` | bool | `false` | Open the job board automatically at startup. | [jobboard/client/feature_flag.py:9](../tools/ClientCodeGrabber/Latest/jobboard/client/feature_flag.py#L9) |
| `job-board-ore-anomalies-enabled-feature-flag` | bool | `true` | Show ore anomalies in the job board. | [jobboard/client/feature_flag.py:17](../tools/ClientCodeGrabber/Latest/jobboard/client/feature_flag.py#L17) |
| `job-board-pirate-insurgency-sites-enabled-feature-flag` | bool | `true` | Show pirate insurgencies in the job board. | [jobboard/client/feature_flag.py:19](../tools/ClientCodeGrabber/Latest/jobboard/client/feature_flag.py#L19) |
| `lighthouse-display-opportunities-ui` | bool | `false` | Opportunity recommendation UI. | [eve/client/script/ui/shared/recommendation/recommendationSvc.py:34](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/shared/recommendation/recommendationSvc.py#L34) |
| `lp-store-heraldry-purchases` | bool | `true` | Heraldry purchases in the LP store. | [cosmetics/client/cosmeticsLicenseSvc.py:28](../tools/ClientCodeGrabber/Latest/cosmetics/client/cosmeticsLicenseSvc.py#L28) |
| `machonet_transport_metrics_enabled` | bool | `false` | MachoNet transport metrics collection. | [carbon/common/script/net/machoNet.py:493](../tools/ClientCodeGrabber/Latest/carbon/common/script/net/machoNet.py#L493) |
| `market-transaction-tax` | float | `8.0` | Client market transaction tax display/calculation percentage. | [eve/client/script/ui/services/marketsvc.py:100](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/services/marketsvc.py#L100) |
| `mission-objectives-enabled-feature-flag` | bool | `true` | Mission objective tracking. | [missions/client/featureFlag.py:8](../tools/ClientCodeGrabber/Latest/missions/client/featureFlag.py#L8) |
| `new-eden-store-intro-enabled-for-user` | bool | `true` | Allow the New Eden Store introduction for this user. | [storylines/client/nes_intro.py:55](../tools/ClientCodeGrabber/Latest/storylines/client/nes_intro.py#L55) |
| `new-omega-upgrade-window-enabled` | bool | `true` | New Omega upgrade window. | [eve/client/script/ui/shared/cloneGrade/__init__.py:31](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/shared/cloneGrade/__init__.py#L31) |
| `pathfinder-custom-color-themes-available` | bool | `false` | Custom UI color themes. | [eve/client/script/ui/shared/systemMenu/theme/feature_flag.py:14](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/shared/systemMenu/theme/feature_flag.py#L14) |
| `pathfinder-new-font-size-options-available` | bool | `false` | New font size options. | [carbonui/text/settings.py:89](../tools/ClientCodeGrabber/Latest/carbonui/text/settings.py#L89) |
| `remove-emblems-lp-cost` | bool | `false` | Remove LP cost from emblems. | [cosmetics/client/cosmeticsLicenseSvc.py:26](../tools/ClientCodeGrabber/Latest/cosmetics/client/cosmeticsLicenseSvc.py#L26) |
| `ship-card-fitting-icon-enabled` | bool | `true` | Fitting icon on ship cards. | [eve/client/script/ui/shared/itemShip.py:54](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/shared/itemShip.py#L54) |
| `skin_hub_offers_enabled` | bool | `true` | SKIN offers in the Paragon Hub. | [cosmetics/client/ships/feature_flag.py:9](../tools/ClientCodeGrabber/Latest/cosmetics/client/ships/feature_flag.py#L9) |
| `skinr_nebulas_enabled` | bool | `false` | Nebula backgrounds in the ship SKINR studio. | [eve/client/script/ui/cosmetics/ship/pages/studio/nebulaConsts.py:10](../tools/ClientCodeGrabber/Latest/eve/client/script/ui/cosmetics/ship/pages/studio/nebulaConsts.py#L10) |
| `skinr_paragon_hub_components_dataset_version` | string | `'default'` | Paragon Hub component offer dataset selection. | [cosmetics/client/ships/feature_flag.py:10](../tools/ClientCodeGrabber/Latest/cosmetics/client/ships/feature_flag.py#L10) |
| `skinr_sequencing_cost_discount` | int | `0` | SKIN sequencing cost discount. | [cosmetics/client/ships/feature_flag.py:11](../tools/ClientCodeGrabber/Latest/cosmetics/client/ships/feature_flag.py#L11) |
| `skinr_sequencing_time_discount` | int | `0` | SKIN sequencing time discount. | [cosmetics/client/ships/feature_flag.py:12](../tools/ClientCodeGrabber/Latest/cosmetics/client/ships/feature_flag.py#L12) |
| `skinr_tier_information_legion` | bool | `false` | Legion tier information for ship SKINs. | [cosmetics/client/ships/feature_flag.py:13](../tools/ClientCodeGrabber/Latest/cosmetics/client/ships/feature_flag.py#L13) |

The default `eve_client_hostile_network_exception_reporting` JSON is:

```json
{
  "exception_FQDNs": ["requests.exceptions.ConnectionError", "socket.error"],
  "ASNs": [5, 6, 7, 8, 9, 10, 11, 12, 13],
  "country_ISOs": ["CN", "RU"]
}
```

## Dynamic callers and limits

`nodegraph/client/conditions/launch_darkly.py:18` registers `launch_darkly_key` supplied by
node data, using that node's `default_value`; there is no fixed flag name or boolean default
in this caller. `eve/client/script/ui/shared/launchdarkly/debugwindow.py:54` also evaluates
arbitrary keys entered in the debug UI, with a JSON fallback of `{}`. These cannot be
represented by an invented static flag list.

The old `xmpp_local_chat_migrated` constant is declared in `chat/common/const.py`, but this
scan did not find a `featuremanagement.client.flag` read for it. Likewise,
`pirate_insurgency_allow_vanguard_influence` is a shared constant without a fixed client
flag read found here. Neither is silently counted as a client flag.

## Verification boundary

The LaunchDarkly recipe still rewrites all six native endpoint URL strings to
`https://localhost`, padded with trailing slashes to preserve their original lengths.
NUL padding is unsafe because native constructors use explicit original lengths.
Local routing normalizes the slash padding and covers the native polling paths
`/msdk/evalx/contexts`, `/msdk/evalx/context`, and `/sdk/latest-all`, plus streaming
and event paths. Evaluation entries contain the native version/value envelope;
the stream sends `event: put` with the same map. No JavaScript SDK metadata is
inserted. Rejected methods and real LaunchDarkly hosts receive empty denials.

The crash recipe still rewrites the minidump URL to the loopback discard endpoint.
Both recipes retain exact original and patched hashes and PE checksum verification.
No gameplay or feature code is patched.

The 2026-09-19 live evidence applies to the former flag-serving implementation.
It does not verify this narrow achievement revision. Serial automated tests cover
verified TLS, polling/streaming evaluations, catalogue delivery, disabled outside
forwarding, launcher health checks and retained patch gates. A fresh in-game UI
playthrough and gameplay/network capture remain pending.
