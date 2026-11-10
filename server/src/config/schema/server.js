"use strict";

module.exports = [
  {
    "key": "devAutoCreateAccounts",
    "defaultValue": true,
    "envVar": "EVEJS_DEV_AUTO_CREATE_ACCOUNTS",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Automatically creates a missing account record on login using the hash the client just supplied."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "devSkipPasswordValidation",
    "defaultValue": true,
    "envVar": "EVEJS_DEV_SKIP_PASSWORD_VALIDATION",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Skips password-hash validation during login so any password can access an existing non-banned account."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "devBootstrapPublishedSkills",
    "defaultValue": false,
    "envVar": "EVEJS_DEV_BOOTSTRAP_PUBLISHED_SKILLS",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Seeds empty/new characters with all published skills at level V instead of the normal racial starter skill bundle."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "clusterDowntimeStarts",
    "defaultValue": "11:00:00",
    "envVar": "EVEJS_CLUSTER_DOWNTIME_STARTS",
    "envType": "string",
    "valueType": "string",
    "description": [
      "UTC daily downtime start used by server-side startup reconciliation.",
      "Matches the target client's zcluster DowntimeStarts value format and falls back to 11:00:00 when unset."
    ],
    "validValues": "UTC time in \"HH:MM:SS\" format.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "defaultCountryCode",
    "defaultValue": "GB",
    "envVar": "EVEJS_DEFAULT_COUNTRY_CODE",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Two-letter ISO country code injected into the initial user session when an account does not define one.",
      "HyperNet visibility checks read session.countryCode during early client startup, so this default keeps the feature available in local dev."
    ],
    "validValues": "Two-letter ISO country code such as \"GB\", \"DE\", or \"US\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "logLevel",
    "defaultValue": 1,
    "envVar": "EVEJS_LOG_LEVEL",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Controls structured EveJS logging: 0 suppresses info/debug output, 1 is normal, and 2 enables verbose diagnostics. Warnings, errors, and critical startup output remain visible at level 0."
    ],
    "validValues": "0 = warnings/errors only, 1 = normal server logging, 2 = verbose debug logging.",
    "allowedValues": [
      0,
      1,
      2
    ],
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "logRetentionHours",
    "defaultValue": 168,
    "envVar": "EVEJS_LOG_RETENTION_HOURS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Keeps this many hours of archives for each log (server.log, inventory-debug.log and so on, each counted on its own) and deletes that log's older archives. Checked at startup and then every hour.",
      "A log that writes rarely keeps its newest hours however long ago they were. Hours come from the archive file names. The log file currently being written is never deleted."
    ],
    "validValues": "0 keeps archives forever; a whole number such as the default 168 (7 days) keeps each log's newest 168 hourly archives.",
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "logArchiveMaxMegabytes",
    "defaultValue": 128,
    "envVar": "EVEJS_LOG_ARCHIVE_MAX_MEGABYTES",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Deletes any hourly log archive larger than this many megabytes. Checked at startup and then every hour.",
      "Archives near Node's maximum string size cannot be read back by the tools that inspect them."
    ],
    "validValues": "0 disables the size limit; a whole number of megabytes such as 128 deletes larger archives.",
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "logPacketPayloadDetails",
    "defaultValue": false,
    "envVar": "EVEJS_LOG_PACKET_PAYLOAD_DETAILS",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "When verbose debug logging is enabled, also dumps decoded packet payload previews and outgoing packet hex summaries on hot network paths."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "spaceBubbleDebugEnabled",
    "defaultValue": false,
    "envVar": "EVEJS_SPACE_BUBBLE_DEBUG_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Writes the high-volume space bubble membership trace when verbose debug logging is enabled. Keep this off unless actively diagnosing bubble visibility."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "spaceMissileDebugEnabled",
    "defaultValue": false,
    "envVar": "EVEJS_SPACE_MISSILE_DEBUG_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Writes the high-volume missile and related Destiny authority trace when verbose debug logging is enabled. Keep this off unless actively diagnosing missile presentation."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "gameServerBindHost",
    "defaultValue": "127.0.0.1",
    "envVar": "EVEJS_GAME_SERVER_BIND_HOST",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Local interface used by the main game TCP listener. Keep this on 127.0.0.1 unless a container or similarly isolated network boundary provides the external localhost-only restriction."
    ],
    "validValues": "Bind address such as \"127.0.0.1\" or \"0.0.0.0\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "serverPort",
    "defaultValue": 26000,
    "envVar": "EVEJS_SERVER_PORT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "TCP port used by the main game server listener."
    ],
    "validValues": "Available TCP port number.",
    "minValue": 1,
    "maxValue": 65535,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "socketKeepAliveEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_SOCKET_KEEPALIVE_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables TCP keep-alive on accepted game client sockets so the OS reaps dead/half-open connections promptly.",
      "Without it an ungracefully dropped client lingers as a live session: the player keeps showing in local chat and station guest lists, and the duplicate-login guard blocks their reconnection until the dead socket finally times out."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "socketKeepAliveInitialDelayMs",
    "defaultValue": 30000,
    "envVar": "EVEJS_SOCKET_KEEPALIVE_INITIAL_DELAY_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Idle time before the OS starts sending TCP keep-alive probes on a game client socket."
    ],
    "validValues": "Non-negative duration in milliseconds.",
    "minValue": 0,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "socketNoDelayEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_SOCKET_NODELAY_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Disables Nagle's algorithm on game client sockets so small RPC packets are sent immediately instead of being buffered.",
      "Lowers latency for the many small request/response packets the MachoNet protocol exchanges."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "socketIdleTimeoutMs",
    "defaultValue": 0,
    "envVar": "EVEJS_SOCKET_IDLE_TIMEOUT_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Optional application-level idle timeout for game client sockets. When greater than 0 a socket with no activity for this long is destroyed.",
      "Left disabled (0) by default because keep-alive already reaps dead peers and a legitimately idle docked client sends no traffic."
    ],
    "validValues": "Non-negative duration in milliseconds. 0 disables the idle timeout.",
    "minValue": 0,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "presenceReconcileIntervalMs",
    "defaultValue": 30000,
    "envVar": "EVEJS_PRESENCE_RECONCILE_INTERVAL_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "How often the presence reconciler re-pushes authoritative who-is-here state so any missed live-presence delta self-heals.",
      "This is the safety net for the fire-and-forget presence broadcasts (local chat membership and station/structure guests). 0 disables the reconciler entirely."
    ],
    "validValues": "Non-negative duration in milliseconds. 0 disables reconciliation.",
    "minValue": 0,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "presenceReconcileChatEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_PRESENCE_RECONCILE_CHAT_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Re-publishes the full authoritative local-chat membership snapshot to each character every reconcile tick.",
      "The snapshot is the same payload the client requests on demand, so re-pushing it is an idempotent full-list refresh."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "presenceReconcileXmppEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_PRESENCE_RECONCILE_XMPP_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Re-asserts each character's XMPP MUC room presence every reconcile tick so chat-window rosters (local, corp, fleet, alliance, militia) self-heal a missed join.",
      "Sends idempotent available-only presence (no leave/rejoin flicker) and skips delayed-local rooms. Disable to cut reconcile traffic on large shards."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "loginTakeoverEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_LOGIN_TAKEOVER_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Controls what happens when a character is selected while an earlier session still holds it.",
      "true (default) makes the new login evict the prior session and take over, letting a player reconnect immediately after an ungraceful drop instead of waiting for keep-alive to reap the stale socket. false keeps the conservative reject — the new login is refused with 'already online'."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "imageServerUrl",
    "defaultValue": "http://127.0.0.1:26001/",
    "envVar": "EVEJS_IMAGE_SERVER_URL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Base URL sent to the client for image and icon requests."
    ],
    "validValues": "Absolute URL string ending with a slash, for example \"http://127.0.0.1:26001/\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "imageServerBindHost",
    "defaultValue": "127.0.0.1",
    "envVar": "EVEJS_IMAGE_SERVER_BIND_HOST",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Host or bind address the local image HTTP server listens on."
    ],
    "validValues": "Host name or IP string such as \"127.0.0.1\" or \"0.0.0.0\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "microservicesBindHost",
    "defaultValue": "127.0.0.1",
    "envVar": "EVEJS_MICROSERVICES_BIND_HOST",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Host or bind address the EveJS microservice and public-gateway bridge listens on."
    ],
    "validValues": "Host name or IP string such as \"127.0.0.1\" or \"0.0.0.0\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "redshiftMonitorHost",
    "defaultValue": "127.0.0.1",
    "envVar": "EVEJS_REDSHIFT_MONITOR_HOST",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Host or bind address the Redshift TiDi monitor API listens on."
    ],
    "validValues": "Host name or IP string such as \"127.0.0.1\" or \"0.0.0.0\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "redshiftMonitorPort",
    "defaultValue": 26400,
    "envVar": "EVEJS_REDSHIFT_MONITOR_PORT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "TCP port used by the Redshift TiDi monitor API."
    ],
    "validValues": "Available TCP port number.",
    "minValue": 1,
    "maxValue": 65535,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "proxyBlockedHosts",
    "defaultValue": "api.ipify.org,sentry.io,.sentry.io,google-analytics.com,.google-analytics.com",
    "envVar": "EVEJS_PROXY_BLOCKED_HOSTS",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Comma-separated hostnames or dot-prefix suffixes to discard locally. All other unhandled proxy destinations are also blocked; this setting cannot allow outbound traffic."
    ],
    "validValues": "Comma-separated host patterns, for example \"api.ipify.org,sentry.io,.sentry.io,google-analytics.com,.google-analytics.com\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "xmppServerBindHost",
    "defaultValue": "127.0.0.1",
    "envVar": "EVEJS_XMPP_SERVER_BIND_HOST",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Local interface used by the XMPP chat listener. Keep this on 127.0.0.1 unless a container or similarly isolated network boundary provides the external localhost-only restriction."
    ],
    "validValues": "Bind address such as \"127.0.0.1\" or \"0.0.0.0\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "xmppConnectHost",
    "defaultValue": "localhost",
    "envVar": "EVEJS_XMPP_CONNECT_HOST",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Host name or IP address returned to the client for the XMPP chat connection target."
    ],
    "validValues": "Host name or IP string such as \"localhost\" or \"chat.example.com\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "xmppDomain",
    "defaultValue": "localhost",
    "envVar": "EVEJS_XMPP_DOMAIN",
    "envType": "string",
    "valueType": "string",
    "description": [
      "XMPP domain used for bare JIDs and chat identity values."
    ],
    "validValues": "Domain or host string such as \"localhost\" or \"chat.example.com\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "xmppConferenceDomain",
    "defaultValue": "",
    "envVar": "EVEJS_XMPP_CONFERENCE_DOMAIN",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Optional XMPP conference domain used for chat room JIDs. Blank derives conference.<xmppDomain> so both settings stay aligned."
    ],
    "validValues": "Blank, or a domain such as \"conference.localhost\" or \"conference.chat.example.com\".",
    "allowBlank": true,
    "integer": false
  },
  {
    "key": "playerConnectToken",
    "defaultValue": "",
    "envVar": "EVEJS_PLAYER_CONNECT_TOKEN",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Shared secret for authenticated helper endpoints. When empty, those endpoints are disabled."
    ],
    "validValues": "A private 32-128 character base64url token, or empty to disable the endpoints.",
    "allowBlank": true,
    "integer": false
  },
  {
    "key": "microservicesPublicUrl",
    "defaultValue": "http://127.0.0.1:26002/",
    "envVar": "EVEJS_MICROSERVICES_PUBLIC_URL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Public base URL advertised for the EveJS gateway and local microservice redirects."
    ],
    "validValues": "Absolute http or https URL ending with a slash.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "microservicesPort",
    "defaultValue": 26002,
    "envVar": "EVEJS_MICROSERVICES_PORT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "TCP port used by the local EveJS gateway listener."
    ],
    "validValues": "Available TCP port from 1 through 65535.",
    "minValue": 1,
    "maxValue": 65535,
    "allowBlank": false,
    "integer": true
  }
];
