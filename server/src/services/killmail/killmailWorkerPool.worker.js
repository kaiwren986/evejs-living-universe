"use strict";

const { parentPort } = require("node:worker_threads");
const { prepareKillmailRecord } = require("./killmailPreparationTasks");

parentPort.on("message", (message) => {
  if (!message || message.type !== "prepare-killmail") {
    return;
  }

  try {
    const result = prepareKillmailRecord(message.record, message.options);
    parentPort.postMessage({
      type: "result",
      taskId: message.taskId,
      result,
    });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      taskId: message.taskId,
      error: error && error.message ? error.message : String(error),
    });
  }
});
