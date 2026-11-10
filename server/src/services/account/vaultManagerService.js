"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const { normalizeText } = require(path.join(
  __dirname,
  "../_shared/serviceHelpers",
));
const log = require(path.join(__dirname, "../../utils/logger"));
const { getCharacterWallet } = require(path.join(__dirname, "./walletState"));

const PLEX_CURRENCY = "PLX";

class VaultManagerService extends BaseService {
  constructor() {
    super("vaultManager");
  }

  Handle_get_account_balance(args, session) {
    const currency = normalizeText(args && args[0], "").toUpperCase();
    const wallet = getCharacterWallet(session && session.characterID);
    const balance =
      currency === PLEX_CURRENCY && wallet ? wallet.plexBalance : 0;

    log.info(
      `[VaultManager] get_account_balance currency=${currency || "<none>"} ` +
        `character=${session && session.characterID ? session.characterID : 0} balance=${balance}`,
    );
    return balance;
  }
}

module.exports = VaultManagerService;
