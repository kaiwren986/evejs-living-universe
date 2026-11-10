"use strict";

// Chat colour commands: /blue, /red, /teal and /yellow, which set the account role that decides
// the colour a character's chat lines are shown in, with the account record read and write, the
// role persistence and the live session update they use.

const path = require("path");

const database = require("../../../gameStore");
const {
  buildPersistedAccountRoleRecord,
  roleToString,
  MAX_ACCOUNT_ROLE,
  normalizeRoleValue,
  DEFAULT_CHAT_ROLE,
  CHAT_ROLE_PROFILES,
  DEFAULT_CHAT_COLOR,
  composeSessionRoleMask,
  getChatRoleProfile,
} = require("../../account/accountRoleProfiles");
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));

function handledResultWithExtras(chatHub, session, options, message, extras = {}) {
  const result = handledResult(chatHub, session, options, message);
  return {
    ...result,
    ...extras,
  };
}

// Phase 0: accounts table access flows through its owner (login/accountStore).
function readAccountsTable() {
  return require("../../login/accountStore").readAccountsTable();
}

function writeAccountsTable(accounts) {
  return require("../../login/accountStore").writeAccountsTable(accounts);
}

function getAccountRecordForSession(session) {
  if (!session) {
    return null;
  }

  const accounts = readAccountsTable();
  const userName = String(session.userName || "").trim();
  if (userName && accounts[userName]) {
    return {
      accounts,
      username: userName,
      account: accounts[userName],
    };
  }

  const matchedEntry = Object.entries(accounts).find(
    ([, account]) => Number(account && account.id) === Number(session.userid || 0),
  );
  if (!matchedEntry) {
    return null;
  }

  return {
    accounts,
    username: matchedEntry[0],
    account: matchedEntry[1],
  };
}

function persistSessionChatRole(session, roleValue) {
  const accountEntry = getAccountRecordForSession(session);
  if (!accountEntry) {
    return {
      success: false,
      errorMsg: "ACCOUNT_NOT_FOUND",
    };
  }

  const nextAccounts = { ...accountEntry.accounts };
  const normalizedAccount = buildPersistedAccountRoleRecord({
    ...accountEntry.account,
    role: roleToString(MAX_ACCOUNT_ROLE),
    chatRole: roleToString(roleValue),
  });
  nextAccounts[accountEntry.username] = normalizedAccount;
  const writeResult = writeAccountsTable(nextAccounts);
  if (!writeResult.success) {
    return {
      success: false,
      errorMsg: writeResult.errorMsg || "ACCOUNT_WRITE_FAILED",
    };
  }
  if (typeof database.flushAllSync === "function") {
    database.flushAllSync();
  }

  return {
    success: true,
    data: normalizedAccount,
  };
}

function getChatColorLabel(roleValue) {
  const normalizedRole = normalizeRoleValue(roleValue, DEFAULT_CHAT_ROLE);
  const match = Object.entries(CHAT_ROLE_PROFILES).find(
    ([, profileRole]) => normalizeRoleValue(profileRole, 0n) === normalizedRole,
  );
  return match ? match[0] : DEFAULT_CHAT_COLOR;
}

function updateSessionRole(session, nextRole) {
  if (!session) {
    return false;
  }

  const normalizedNextRole = normalizeRoleValue(nextRole, DEFAULT_CHAT_ROLE);
  const previousRole = composeSessionRoleMask(
    session.accountRole ?? session.role,
    session.chatRole ?? session.role,
  );
  const nextSessionRole = composeSessionRoleMask(
    session.accountRole ?? session.role,
    normalizedNextRole,
  );

  session.chatRole = roleToString(normalizedNextRole);
  session.role = roleToString(nextSessionRole);

  if (
    previousRole !== nextSessionRole &&
    typeof session.sendSessionChange === "function"
  ) {
    session.sendSessionChange({
      role: [previousRole, nextSessionRole],
    });
  }

  return previousRole !== nextSessionRole;
}

function handleChatColorCommand(session, colorName, chatHub, options) {
  const nextRole = getChatRoleProfile(colorName);
  if (!nextRole) {
    return handledResult(
      chatHub,
      session,
      options,
      `Unknown chat color: ${colorName}. Use /blue, /red, /teal, or /yellow.`,
    );
  }

  const persisted = persistSessionChatRole(session, nextRole);
  if (!persisted.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Chat color change failed: account record could not be updated.",
    );
  }

  updateSessionRole(session, nextRole);
  return handledResultWithExtras(
    chatHub,
    session,
    options,
    `Chat color set to ${getChatColorLabel(nextRole)}.`,
    {
      refreshChatRolePresence: true,
    },
  );
}

module.exports = {
  handleChatColorCommand,
};
