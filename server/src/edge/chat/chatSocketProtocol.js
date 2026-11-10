"use strict";

const CHAT_OWNER_COMMAND = Object.freeze({
  OPEN: "chat.socket.open",
  DATA: "chat.socket.data",
  CLOSE: "chat.socket.close",
  ERROR: "chat.socket.error",
  DRAIN: "chat.socket.drain",
});

const CHAT_EDGE_COMMAND = Object.freeze({
  WRITE: "chat.socket.write",
  END: "chat.socket.end",
  DESTROY: "chat.socket.destroy",
});

module.exports = {
  CHAT_EDGE_COMMAND,
  CHAT_OWNER_COMMAND,
};
