"use strict";

module.exports = [
  {
    "key": "hyperNetKillSwitch",
    "defaultValue": false,
    "envVar": "EVEJS_HYPERNET_KILL_SWITCH",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Exposes HyperNetKillSwitch through machoNet global config so the client can gate HyperNet availability."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "hyperNetPlexPriceOverride",
    "defaultValue": 3500000,
    "envVar": "EVEJS_HYPERNET_PLEX_PRICE_OVERRIDE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Fixed PLEX price exposed through machoNet global config for HyperNet token calculations.",
      "Using the same override on both client and server keeps token requirements deterministic in local development."
    ],
    "validValues": "Positive integer ISK value such as 3500000.",
    "minValue": 0,
    "exclusiveMinValue": true,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "hyperNetSeedEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_HYPERNET_SEED_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables optional HyperNet startup seeding using GM Elysian's home-station hangar.",
      "This is kept separate from the persistent raffle core so seeded demo listings can be turned off cleanly."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "hyperNetSeedOwnerId",
    "defaultValue": 140000004,
    "envVar": "EVEJS_HYPERNET_SEED_OWNER_ID",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Character ID used as the seller/source hangar for optional HyperNet startup seeding."
    ],
    "validValues": "Positive character ID.",
    "minValue": 1,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "hyperNetSeedRestockEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_HYPERNET_SEED_RESTOCK_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Allows the HyperNet seed manager to restock GM seed inventory before creating demo listings."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "marketDaemonHost",
    "defaultValue": "127.0.0.1",
    "envVar": "EVEJS_MARKET_DAEMON_HOST",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Host name or IP address used by the main server to reach the standalone Rust market daemon RPC listener."
    ],
    "validValues": "Host name or IP string such as \"127.0.0.1\" or \"192.168.1.20\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "marketDaemonPort",
    "defaultValue": 40111,
    "envVar": "EVEJS_MARKET_DAEMON_PORT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "TCP port used by the main server when forwarding marketProxy calls to the standalone market daemon RPC listener."
    ],
    "validValues": "Available TCP port number.",
    "minValue": 1,
    "maxValue": 65535,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "marketDaemonConnectTimeoutMs",
    "defaultValue": 1500,
    "envVar": "EVEJS_MARKET_DAEMON_CONNECT_TIMEOUT_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "How long the main server waits for the market daemon TCP connection to open before treating it as unavailable."
    ],
    "validValues": "Positive integer duration in milliseconds.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "marketDaemonRequestTimeoutMs",
    "defaultValue": 15000,
    "envVar": "EVEJS_MARKET_DAEMON_REQUEST_TIMEOUT_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "How long an individual forwarded market RPC call may take before the main server fails it."
    ],
    "validValues": "Positive integer duration in milliseconds.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "marketDaemonRetryDelayMs",
    "defaultValue": 2000,
    "envVar": "EVEJS_MARKET_DAEMON_RETRY_DELAY_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Delay between background reconnect attempts when the main server is waiting for the standalone market daemon to come online."
    ],
    "validValues": "Positive integer duration in milliseconds.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "newEdenStoreEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_NEW_EDEN_STORE_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables the cache-backed New Eden Store, legacy storeManager catalog, and public payment surfaces."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "newEdenStoreFastCheckoutEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_NEW_EDEN_STORE_FAST_CHECKOUT_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables the legacy FastCheckoutService path the client uses for in-game PLEX purchases."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "newEdenStoreFakeCashPurchasesEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_NEW_EDEN_STORE_FAKE_CASH_PURCHASES_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Lets cash purchase attempts succeed locally and grant the selected offer without touching a real payment processor."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "newEdenStoreCentsPerPlex",
    "defaultValue": 100,
    "envVar": "EVEJS_NEW_EDEN_STORE_CENTS_PER_PLEX",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Conversion rate used by the store purchase helpers when translating stored PLEX offer pricing into whole PLEX debits."
    ],
    "validValues": "Positive integer such as 100.",
    "minValue": 1,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "newEdenStoreDefaultCashTaxRatePoints",
    "defaultValue": 0,
    "envVar": "EVEJS_NEW_EDEN_STORE_DEFAULT_CASH_TAX_RATE_POINTS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Tax rate in basis points applied to fake cash CostRequest calculations for public payment flows."
    ],
    "validValues": "Non-negative integer. 100 = 1%.",
    "minValue": 0,
    "maxValue": 10000,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "newEdenStorePurchaseLogLimit",
    "defaultValue": 500,
    "envVar": "EVEJS_NEW_EDEN_STORE_PURCHASE_LOG_LIMIT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Maximum number of completed New Eden Store purchases retained in the cache-backed runtime log."
    ],
    "validValues": "Positive integer.",
    "minValue": 10,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "hyperNetSeedShips",
    "defaultValue": 5,
    "envVar": "EVEJS_HYPERNET_SEED_SHIPS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Deterministic number of demo ship raffles targeted by HyperNet startup seeding."
    ],
    "validValues": "Integer from 0 through 100.",
    "minValue": 0,
    "maxValue": 100,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "hyperNetSeedItems",
    "defaultValue": 5,
    "envVar": "EVEJS_HYPERNET_SEED_ITEMS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Deterministic number of demo non-ship raffles targeted by HyperNet startup seeding."
    ],
    "validValues": "Integer from 0 through 100.",
    "minValue": 0,
    "maxValue": 100,
    "allowBlank": false,
    "integer": true
  }
];
