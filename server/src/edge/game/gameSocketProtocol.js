"use strict";

const GAME_OWNER_COMMAND = Object.freeze({
  OPEN: "game.socket.open",
  FRAME: "game.socket.frame",
  CLOSE: "game.socket.close",
  ERROR: "game.socket.error",
  DRAIN: "game.socket.drain",
});

const MAX_GAME_PAYLOAD_LENGTH = 10_000_000;

const GAME_EDGE_COMMAND = Object.freeze({
  ACTIVATE_TRANSPORT: "game.transport.activate",
  WRITE: "game.socket.write",
  WRITE_PAYLOAD: "game.socket.write-payload",
  END: "game.socket.end",
  DESTROY: "game.socket.destroy",
});

module.exports = {
  GAME_EDGE_COMMAND,
  GAME_OWNER_COMMAND,
  MAX_GAME_PAYLOAD_LENGTH,
};
