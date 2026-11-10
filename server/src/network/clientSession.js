"use strict";

/**
 * Client Session
 *
 * Tracks per-client session attributes after the handshake completes.
 * Ported from EVEClientSession / ClientSession in the C++ server.
 *
 * Session attributes mirror what the C++ server tracks:
 *   userid, characterID, corporationID, stationID, solarsystemid, role, etc.
 */

const path = require("path");
const { resolveDataRootPath } = require(path.join(__dirname, "../config/dataRoot"));
const log = require(path.join(__dirname, "../utils/logger"));
const rotatingLog = require(path.join(__dirname, "../utils/rotatingLog"));
const syncLedger = require(path.join(__dirname, "./syncLedger"));
const {
  sendTaleDataAfterSessionChange,
} = require(path.join(__dirname, "../services/tale/taleSessionNotices"));
const spatialTrace = require(path.join(__dirname, "./spatialTrace"));
const serviceCallShapeCapture = require(path.join(
  __dirname,
  "../services/_shared/serviceCallShapeCapture",
));
const {
  toWireNotificationPayload,
} = require(path.join(__dirname, "./attributeChangeWireValues"));
const {
  readCharacterOwnAttributes,
} = require(path.join(__dirname, "../services/character/characterOwnAttributes"));
const marshalWorkerPool = require(path.join(
  __dirname,
  "./marshalWorkerPool",
));
const { marshalEncode, marshalDecode, encodePacket } = require(
  path.join(__dirname, "./tcp/utils/marshal"),
);
const { MACHONETMSG_TYPE } = require(
  path.join(__dirname, "../common/packetTypes"),
);
const { encodeAddress } = require(
  path.join(__dirname, "../common/machoAddress"),
);
const { PROXY_NODE_ID } = require(path.join(__dirname, "./protocolProfile"));
const {
  composeSessionRoleMask,
} = require(path.join(
  __dirname,
  "../services/account/accountRoleProfiles",
));
const sessionChangeDebugPath = resolveDataRootPath("logs", "session-change-debug.log");
const SESSION_CHANGE_ALLOWED_KEYS = new Set([
  "role",
  "countryCode",
  "charid",
  "corpid",
  "corpAccountKey",
  "hqID",
  "allianceid",
  "factionid",
  "warfactionid",
  "genderID",
  "bloodlineID",
  "raceID",
  "schoolID",
  "stationid",
  "stationid2",
  "structureid",
  "solarsystemid",
  "solarsystemid2",
  "locationid",
  "worldspaceid",
  "constellationid",
  "regionid",
  "shipid",
  "fleetid",
  "fleetrole",
  "wingid",
  "squadid",
  "corprole",
  "rolesAtAll",
  "rolesAtBase",
  "rolesAtHQ",
  "rolesAtOther",
]);

function normalizeSessionChangeNodeID(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.trunc(numeric)
    : PROXY_NODE_ID;
}

function normalizeSessionChangeNodesOfInterest(options = {}, sourceNodeID = 0) {
  if (Array.isArray(options.nodesOfInterest)) {
    return options.nodesOfInterest
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry))
      .map((entry) => Math.trunc(entry));
  }
  const fallbackNodeID = normalizeSessionChangeNodeID(sourceNodeID);
  return fallbackNodeID > 0 ? [fallbackNodeID] : [];
}

function buildNotificationNamedPayloadEntries(session) {
  if (!session || typeof session !== "object") {
    return [];
  }
  const previousSequence = Number.isFinite(Number(session._notificationSequenceNumber))
    ? Math.trunc(Number(session._notificationSequenceNumber))
    : -1;
  const nextSequence = previousSequence + 1;
  session._notificationSequenceNumber = nextSequence;
  return [["sn", nextSequence]];
}

function buildBroadcastNotificationMarshalValue(payloadTuple = []) {
  return [0, [1, payloadTuple]];
}

function buildClientCallNamedPayloadEntries(machoTimeout) {
  const normalizedMachoTimeout = Number(machoTimeout) > 0
    ? Math.trunc(Number(machoTimeout))
    : 0;
  return normalizedMachoTimeout > 0
    ? [["machoTimeout", normalizedMachoTimeout]]
    : [];
}

function recordSpaceBootstrapTrace(session, event, details = {}) {
  if (!session || !log.isVerboseDebugEnabled()) {
    return false;
  }
  try {
    const spaceRuntime = require(path.join(__dirname, "../space/runtime"));
    if (
      spaceRuntime &&
      typeof spaceRuntime.recordSessionJumpTimingTrace === "function"
    ) {
      return (
        spaceRuntime.recordSessionJumpTimingTrace(session, event, details) === true
      );
    }
  } catch (error) {
    log.debug(
      `[Session] Failed to record space bootstrap trace: ${error.message}`,
    );
  }
  return false;
}

function summarizeOutgoingPacket(value, explicitMeta = null) {
  if (explicitMeta && typeof explicitMeta === "object") {
    return explicitMeta;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const packetName = String(value.name || "");
  if (packetName.endsWith("SessionChangeNotification")) {
    return {
      kind: "session-change",
      packetName,
    };
  }

  if (!packetName.endsWith("CallRsp")) {
    return null;
  }

  const args = Array.isArray(value.args) ? value.args : [];
  const sourceAddress = args[1];
  const sourceArgs =
    sourceAddress && Array.isArray(sourceAddress.args) ? sourceAddress.args : [];
  return {
    kind: "call-response",
    packetName,
    service:
      typeof sourceArgs[2] === "string" && sourceArgs[2].trim().length > 0
        ? sourceArgs[2]
        : null,
    callID: Number(sourceArgs[3]) || 0,
  };
}

function buildMarshalDict(entries = []) {
  return {
    type: "dict",
    entries: Array.isArray(entries) ? entries : [],
  };
}

function appendSessionChangeDebug(entry) {
  if (!log.isVerboseDebugEnabled()) {
    return;
  }
  try {
    rotatingLog.append(sessionChangeDebugPath, `[${new Date().toISOString()}] ${entry}\n`);
  } catch (error) {
    log.warn(
      `[Session] Failed to write session change debug log: ${error.message}`,
    );
  }
}

function summarizeAttributeChangeCounts(changes = []) {
  const counts = new Map();
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!Array.isArray(change) || change.length < 4) {
      continue;
    }

    const attributeID = Number(change[3]);
    if (!Number.isFinite(attributeID)) {
      continue;
    }

    counts.set(attributeID, (counts.get(attributeID) || 0) + 1);
  }

  const entries = [...counts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([attributeID, count]) => `${attributeID}x${count}`);

  if (entries.length <= 6) {
    return entries.join(",");
  }

  return `${entries.slice(0, 6).join(",")},+${entries.length - 6} more`;
}

function buildNotificationLogMessage(notifyType, idType, payloadTuple = []) {
  const base = `idType=${idType}`;
  if (notifyType !== "OnModuleAttributeChanges") {
    return base;
  }

  const payload = Array.isArray(payloadTuple) ? payloadTuple[0] : null;
  const changes =
    payload &&
    typeof payload === "object" &&
    payload.type === "list" &&
    Array.isArray(payload.items)
      ? payload.items
      : [];
  if (changes.length === 0) {
    return `${base} changes=0`;
  }

  return `${base} changes=${changes.length} attrs=${summarizeAttributeChangeCounts(changes)}`;
}

function currentFileTime() {
  return BigInt(Date.now()) * 10000n + 116444736000000000n;
}

function resolveBoundObjectRegistrationRefID(session, objectID) {
  if (
    !session ||
    typeof objectID !== "string" ||
    objectID.trim() === "" ||
    !session._boundObjectState ||
    typeof session._boundObjectState !== "object"
  ) {
    return currentFileTime();
  }

  for (const state of Object.values(session._boundObjectState)) {
    if (
      state &&
      typeof state === "object" &&
      state.objectID === objectID &&
      state.boundAtFileTime !== undefined &&
      state.boundAtFileTime !== null
    ) {
      return state.boundAtFileTime;
    }
  }

  return currentFileTime();
}

class ClientSession {
  /**
   * @param {object} handshakeData - Data from the completed handshake
   * @param {net.Socket} socket - The TCP socket for this client
   * @param {object} options - Encryption state (key, iv, encrypt/decrypt funcs)
   */
  constructor(handshakeData, socket, options = {}) {
    // Core identity
    this.userid = handshakeData.userId || 0;
    this.userName = handshakeData.userName || "";
    this.clientID = handshakeData.clientId || 0;
    this.clientId = this.clientID; // alias for camelCase consistency
    this.accountRole = handshakeData.accountRole || handshakeData.role || 0;
    this.chatRole = handshakeData.chatRole || handshakeData.role || 0;
    this.role = composeSessionRoleMask(
      this.accountRole,
      this.chatRole,
    );
    this.languageID = handshakeData.languageId || "EN";
    this.countryCode = handshakeData.countryCode || null;
    this.sid =
      typeof handshakeData.sessionId === "bigint"
        ? handshakeData.sessionId
        : BigInt(handshakeData.sessionId || (Date.now() * 15));
    this.sessionID = this.sid;

    // Character data (set after character selection)
    this.characterID = 0;
    this.characterName = "";
    this.characterTypeID = 1373;
    this.genderID = 1;
    this.bloodlineID = 1;
    this.raceID = 1;
    this.empireID = null;
    this.factionID = null;
    this.factionid = null;
    this.schoolID = null;
    this.corporationID = 0;
    this.allianceID = 0;
    this.stationID = 0;
    this.structureID = 0;
    this.solarsystemid = 0;
    this.constellationID = 0;
    this.regionID = 0;
    this.shipID = 0;
    this.shipName = "";
    this.fleetid = null;
    this.fleetrole = null;
    this.wingid = null;
    this.squadid = null;
    this.cloneStationID = 0;
    this.hqID = 0;
    this.baseID = 0;
    this.warFactionID = 0;

    // Network
    this.socket = socket;
    this.address = socket ? socket.remoteAddress : "unknown";

    // Encryption state
    this.encrypted = options.encrypted || false;
    this.sessionKey = options.sessionKey || null;
    this.sessionIV = options.sessionIV || null;
    this._encryptFn = options.encryptFn || null;
    this._decryptFn = options.decryptFn || null;
    this.transportCryptoOffloaded = options.transportCryptoOffloaded === true;

    // Timestamps
    this.connectTime = Date.now();
    this.lastActivity = Date.now();
    this._notificationSequenceNumber = -1;
    this._outboundTail = null;
    syncLedger.trackSocketLifecycle(this);
  }

  /**
   * Send a marshaled packet to this client.
   * The value is encoded, optionally encrypted, and framed with a 4-byte length.
   */
  sendPacket(value, spatialTraceContext = null) {
    const pendingPerfMeta = this._pendingBootstrapPacketPerf || null;
    this._pendingBootstrapPacketPerf = null;
    const packetPerfMeta = summarizeOutgoingPacket(value, pendingPerfMeta);

    if (!this.socket || this.socket.destroyed) {
      log.warn(`[Session] Cannot send to ${this.address}: socket closed`);
      syncLedger.recordSyncLedgerEvent(this, "packet.dropped", {
        ...(packetPerfMeta || {}),
        reason: "socket-closed",
      });
      return;
    }

    this.lastActivity = Date.now();
    const packetLedger = syncLedger.recordSyncLedgerEvent(
      this,
      "packet.begin",
      packetPerfMeta || {},
    );

    const forceMarshalOffload = this.socket.offloadAllMarshal === true;
    const shouldConsiderOffload = forceMarshalOffload ||
      (packetPerfMeta && packetPerfMeta.kind === "call-response");
    const plan = shouldConsiderOffload
      ? marshalWorkerPool.plan(
        "marshal",
        value,
        {},
        { force: forceMarshalOffload },
      )
      : null;

    if (plan && plan.mode === "worker") {
      const workerOutcome = plan.promise.then(
        (encoded) => ({ encoded, error: null }),
        (error) => ({ encoded: null, error }),
      );
      return this._enqueueOutbound(async () => {
        const outcome = await workerOutcome;
        let encoded = outcome.encoded;
        let marshalMode = "worker";
        if (!encoded) {
          const encodeStartedAtMs = Date.now();
          const marshaled = marshalEncode(value);
          encoded = {
            buffer: marshaled,
            encodeMs: Date.now() - encodeStartedAtMs,
            queueMs: 0,
            wallMs: 0,
          };
          marshalMode = "inline-fallback";
          marshalWorkerPool.recordInline("fallback", encoded);
          log.warn(
            `[MarshalWorker] Falling back inline for ${
              packetPerfMeta.service || "?"
            }.${packetPerfMeta.method || "?"}: ${outcome.error.message}`,
          );
        }
        return this._completePacketSend({
          value,
          spatialTraceContext,
          packetPerfMeta,
          packetLedger,
          marshaled: encoded.buffer,
          encodeElapsedMs: encoded.encodeMs,
          marshalMode,
          marshalEstimate: plan.estimate,
          marshalQueueMs: encoded.queueMs,
          marshalWallMs: encoded.wallMs,
        });
      });
    }

    // Marshal the value
    const encodeStartedAtMs = Date.now();
    const marshaled = marshalEncode(value);
    const encodeElapsedMs = Date.now() - encodeStartedAtMs;
    if (plan) {
      marshalWorkerPool.recordInline(plan.reason, { encodeMs: encodeElapsedMs });
    }

    const complete = () => this._completePacketSend({
      value,
      spatialTraceContext,
      packetPerfMeta,
      packetLedger,
      marshaled,
      encodeElapsedMs,
      marshalMode: plan ? "inline" : "direct",
      marshalEstimate: plan ? plan.estimate : null,
      marshalQueueMs: 0,
      marshalWallMs: encodeElapsedMs,
    });
    return this._outboundTail ? this._enqueueOutbound(complete) : complete();
  }

  _enqueueOutbound(operation) {
    const previous = this._outboundTail || Promise.resolve();
    const queued = previous.then(operation).catch((error) => {
      log.err(`[Session] Ordered outbound operation failed: ${error.message}`);
      return null;
    });
    this._outboundTail = queued;
    queued.finally(() => {
      if (this._outboundTail === queued) {
        this._outboundTail = null;
      }
    }).catch(() => {});
    return queued;
  }

  drainOutbound() {
    return this._outboundTail || Promise.resolve();
  }

  _completePacketSend({
    value,
    spatialTraceContext,
    packetPerfMeta,
    packetLedger,
    marshaled,
    encodeElapsedMs,
    marshalMode,
    marshalEstimate,
    marshalQueueMs,
    marshalWallMs,
  }) {
    serviceCallShapeCapture.capturePacketShape({
      direction: "outbound",
      rawDecoded: value,
      context: packetPerfMeta,
      session: this,
      encodedBytes: marshaled.length,
      encrypted: this.encrypted === true,
    });

    if (!this.socket || this.socket.destroyed) {
      syncLedger.recordSyncLedgerEvent(this, "packet.dropped", {
        ...(packetPerfMeta || {}),
        packetSeq: packetLedger.seq,
        bytes: marshaled.length,
        marshalMode,
        reason: "socket-closed-before-write",
      });
      return null;
    }

    if (log.isPacketPayloadDebugEnabled()) {
      log.debug(`[Session] Sending packet (${marshaled.length} bytes)`);
      log.debug(
        `[Session] Outgoing hex: ${marshaled.toString("hex").substring(0, 160)}...`,
      );
    }

    const writeStartedAtMs = Date.now();
    const writeResult = this._writePayload(marshaled);
    const writeElapsedMs = Date.now() - writeStartedAtMs;

    if (spatialTraceContext) {
      spatialTrace.recordNotificationSent(this, spatialTraceContext, {
        outerMarshalByteLength: marshaled.length,
        bodyByteLength: writeResult ? writeResult.bodyBytes : null,
        framedByteLength: writeResult ? writeResult.framedBytes : null,
        encrypted: this.encrypted === true,
        socketWriteAccepted:
          writeResult && Object.prototype.hasOwnProperty.call(writeResult, "writeAccepted")
            ? writeResult.writeAccepted
            : null,
      });
    }

    syncLedger.recordSyncLedgerEvent(this, "packet.sent", {
      ...(packetPerfMeta || {}),
      packetSeq: packetLedger.seq,
      bytes: marshaled.length,
      encodeMs: encodeElapsedMs,
      marshalMode,
      marshalEstimatedBytes: marshalEstimate
        ? marshalEstimate.estimatedBytes
        : null,
      marshalEstimatedNodes: marshalEstimate ? marshalEstimate.nodes : null,
      marshalQueueMs: Number(marshalQueueMs) || 0,
      marshalWallMs: Number(marshalWallMs) || encodeElapsedMs,
      writeMs: writeElapsedMs,
      encrypted: this.encrypted === true,
      writeAccepted:
        writeResult && Object.prototype.hasOwnProperty.call(writeResult, "writeAccepted")
          ? writeResult.writeAccepted
          : null,
      framedBytes: writeResult ? writeResult.framedBytes : null,
      socketWritableLength: this.socket ? Number(this.socket.writableLength || 0) : null,
    });

    if (packetPerfMeta) {
      recordSpaceBootstrapTrace(this, "outgoing-packet", {
        ...packetPerfMeta,
        bytes: marshaled.length,
        encodeMs: encodeElapsedMs,
        marshalMode,
        marshalEstimatedBytes: marshalEstimate
          ? marshalEstimate.estimatedBytes
          : null,
        marshalEstimatedNodes: marshalEstimate ? marshalEstimate.nodes : null,
        marshalQueueMs: Number(marshalQueueMs) || 0,
        marshalWallMs: Number(marshalWallMs) || encodeElapsedMs,
        writeMs: writeElapsedMs,
        encrypted: this.encrypted === true,
      });
      if (
        encodeElapsedMs >= 100 ||
        Number(marshalQueueMs) >= 25 ||
        Number(marshalWallMs) >= 100 ||
        writeElapsedMs >= 25
      ) {
        log.info(
          `[SessionPerf] packet kind=${packetPerfMeta.kind || "unknown"} ` +
          `service=${packetPerfMeta.service || "?"} callID=${Number(packetPerfMeta.callID) || 0} ` +
          `bytes=${marshaled.length} encodeMs=${Number(encodeElapsedMs).toFixed(2)} ` +
          `marshalMode=${marshalMode} queueMs=${Number(marshalQueueMs || 0).toFixed(2)} ` +
          `writeMs=${writeElapsedMs}`,
        );
      }
    }
    return writeResult;
  }

  /**
   * Send a raw post-handshake payload to this client.
   * This bypasses marshal encoding but still uses the normal length-prefix and
   * session encryption path, which is what native BlueNet TiDi frames need.
   */
  sendRawPayload(payload, options = {}) {
    if (!this.socket || this.socket.destroyed) {
      log.warn(`[Session] Cannot send raw payload to ${this.address}: socket closed`);
      syncLedger.recordSyncLedgerEvent(this, "packet.dropped", {
        kind: "raw",
        label: options && options.label ? String(options.label) : "raw",
        reason: "socket-closed",
      });
      return;
    }

    if (!Buffer.isBuffer(payload)) {
      throw new TypeError("sendRawPayload expects a Buffer payload");
    }

    this.lastActivity = Date.now();

    const label = options.label || "raw";
    const ledger = syncLedger.recordSyncLedgerEvent(this, "packet.begin", {
      kind: "raw",
      label,
      bytes: payload.length,
      encrypted: this.encrypted === true,
    });
    const payloadSnapshot = this._outboundTail ? Buffer.from(payload) : payload;
    const write = () => {
      if (!this.socket || this.socket.destroyed) {
        syncLedger.recordSyncLedgerEvent(this, "packet.dropped", {
          kind: "raw",
          label,
          packetSeq: ledger.seq,
          bytes: payloadSnapshot.length,
          reason: "socket-closed-before-write",
        });
        return null;
      }
      if (log.isPacketPayloadDebugEnabled()) {
        log.debug(
          `[Session] Sending raw payload (${payloadSnapshot.length} bytes) [${label}]`,
        );
        log.debug(
          `[Session] Outgoing raw hex: ${payloadSnapshot.toString("hex").substring(0, 160)}...`,
        );
      }

      const startedAtMs = Date.now();
      const writeResult = this._writePayload(payloadSnapshot);
      syncLedger.recordSyncLedgerEvent(this, "packet.sent", {
        kind: "raw",
        label,
        packetSeq: ledger.seq,
        bytes: payloadSnapshot.length,
        writeMs: Date.now() - startedAtMs,
        encrypted: this.encrypted === true,
        writeAccepted:
          writeResult && Object.prototype.hasOwnProperty.call(writeResult, "writeAccepted")
            ? writeResult.writeAccepted
            : null,
        framedBytes: writeResult ? writeResult.framedBytes : null,
        socketWritableLength: this.socket
          ? Number(this.socket.writableLength || 0)
          : null,
      });
      return writeResult;
    };
    return this._outboundTail ? this._enqueueOutbound(write) : write();
  }

  _writePayload(payload) {
    if (
      this.transportCryptoOffloaded &&
      this.socket &&
      typeof this.socket.writePayload === "function"
    ) {
      return this.socket.writePayload(payload);
    }
    if (this.encrypted && this._encryptFn) {
      // Encrypt, then frame
      const encrypted = this._encryptFn(payload);
      const header = Buffer.alloc(4);
      header.writeUInt32LE(encrypted.length, 0);
      const framed = Buffer.concat([header, encrypted]);
      return {
        bodyBytes: encrypted.length,
        framedBytes: framed.length,
        writeAccepted: this.socket.write(framed) !== false,
      };
    } else {
      // Frame without encryption
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.length, 0);
      const framed = Buffer.concat([header, payload]);
      return {
        bodyBytes: payload.length,
        framedBytes: framed.length,
        writeAccepted: this.socket.write(framed) !== false,
      };
    }
  }

  /**
   * Decrypt incoming raw packet data.
   * @param {Buffer} data - Raw payload (after removing 4-byte length header)
   * @returns {Buffer} Decrypted data
   */
  decryptPacket(data) {
    if (this.transportCryptoOffloaded) return data;
    if (this.encrypted && this._decryptFn) {
      return this._decryptFn(data);
    }
    return data;
  }

  /**
   * Send a SessionChangeNotification (type 16) to the client.
   *
   * This is sent after character selection to inform the client of
   * all session attribute changes (characterID, stationID, etc.).
   *
   * The payload format is: [sessionID, sessionDict]
   *   sessionDict contains entries of [oldValue, newValue] pairs.
   *
   * From EVEmu C++ SessionChangeNotification::Encode():
   *   PyObject("macho.SessionChangeNotification", [type, src, dst, userID, payload, {}, null])
   */
  sendSessionChange(changes, options = {}) {
    if (!this.socket || this.socket.destroyed) {
      syncLedger.recordSyncLedgerEvent(this, "packet.dropped", {
        kind: "session-change",
        reason: "socket-closed",
      });
      return;
    }

    // Build the session change dict — each entry is [oldValue, newValue]
    const changeEntries = [];
    for (const [key, [oldVal, newVal]] of Object.entries(changes)) {
      if (!SESSION_CHANGE_ALLOWED_KEYS.has(key)) {
        appendSessionChangeDebug(
          `drop key=${key} old=${JSON.stringify(oldVal, (k, v) => (typeof v === "bigint" ? v.toString() : v))} new=${JSON.stringify(newVal, (k, v) => (typeof v === "bigint" ? v.toString() : v))}`,
        );
        continue;
      }
      changeEntries.push([key, [oldVal, newVal]]);
    }
    const sessionID =
      options && Object.prototype.hasOwnProperty.call(options, "sessionId")
        ? typeof options.sessionId === "bigint"
          ? options.sessionId
          : BigInt(options.sessionId || 0)
        : this.sid;
    const sourceNodeID = normalizeSessionChangeNodeID(options.sourceNodeID);
    const nodesOfInterest = normalizeSessionChangeNodesOfInterest(
      options,
      sourceNodeID,
    );

    if (changeEntries.length === 0 && options.allowEmpty !== true) {
      appendSessionChangeDebug(
        `skip sid=${String(sessionID)} reason=empty payload=[]`,
      );
      return;
    }

    appendSessionChangeDebug(
      `send sid=${String(sessionID)} keys=${JSON.stringify(changeEntries.map(([key]) => key))} payload=${JSON.stringify(changeEntries, (k, v) => (typeof v === "bigint" ? v.toString() : v))}`,
    );

    // SessionChangeNotification payload per General.xmlp:
    //   tuple(sessionID: long, tuple(clueless: int, changes: dict), nodesOfInterest: listInt)
    const payload = [
      { type: "long", value: sessionID }, // sessionID
      [0, { type: "dict", entries: changeEntries }], // [clueless=0, changes dict]
      { type: "list", items: nodesOfInterest }, // nodesOfInterest
    ];

    const responseTuple = [
      MACHONETMSG_TYPE.SESSIONCHANGENOTIFICATION, // type = 16
      encodeAddress({
        type: "node",
        nodeID: sourceNodeID,
        callID: 0,
        service: null,
      }),
      encodeAddress({
        type: "client",
        clientID: this.clientID,
        callID: 0,
        service: null,
      }),
      this.userid || null,
      payload, // payload tuple (NOT wrapped in extra array)
      { type: "dict", entries: [] }, // named payload
      null, // contextKey
      null, // traceID/bssid (8th element required)
      null, // spanID/bssctx (9th element required)
      null, // 10th
      null, // 11th
      null, // 12th
      null, // 13th
      null, // 14th
    ];

    const packet = {
      type: "object",
      name: "carbon.common.script.net.machoNetPacket.SessionChangeNotification",
      args: responseTuple,
    };

    log.pktOut(
      "SessionChange",
      `${changeEntries.length} changes → ${changeEntries.map(([k]) => k).join(", ")}`,
    );
    this._pendingBootstrapPacketPerf = {
      kind: "session-change",
      packetName: packet.name,
      changeKeys: changeEntries.map(([key]) => key),
      sessionID: String(sessionID),
    };
    this.sendPacket(packet);

    // Tranquility's word after a change of solar system: the tales of the
    // system the session has come to.
    sendTaleDataAfterSessionChange(this, Object.fromEntries(changeEntries));

    if (changeEntries.length > 0) {
      try {
        const {
          synchronizeSessionChatState,
        } = require(path.join(__dirname, "../services/chat/sessionChatSync"));
        if (typeof synchronizeSessionChatState === "function") {
          synchronizeSessionChatState(this, Object.fromEntries(changeEntries));
        }
      } catch (error) {
        log.debug(
          `[Session] Skipped chat sync after session change: ${error.message}`,
        );
      }
    }
  }

  /**
   * The session's character's own five attributes by attribute ID, as its
   * record has them, or null where there is no character or no record of it.
   * For telling a change of one of them that is the character's own value from
   * one that has something added to it (attributeChangeWireValues.js). Null
   * also where the read throws.
   */
  readOwnCharacterAttributes() {
    const characterID = Number(this.characterID || this.charid) || 0;
    try {
      const {
        getCharacterRecord,
      } = require(path.join(__dirname, "../services/character/characterState"));
      const record = getCharacterRecord(characterID);
      return record ? readCharacterOwnAttributes(record.characterAttributes) : null;
    } catch (error) {
      log.debug(
        `[Session] No own attributes for character=${characterID}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Send a MACHONETMSG_TYPE.NOTIFICATION to the client.
   * Mirrors EVEmu's `Client::SendNotification(notifyType, idType, payload)`
   */
  sendNotification(notifyType, idType, payloadTuple = []) {
    if (!this.socket || this.socket.destroyed) {
      syncLedger.recordSyncLedgerEvent(this, "packet.dropped", {
        kind: "notification",
        notifyType: notifyType || "Notification",
        idType: idType || "ownerid",
        reason: "socket-closed",
        ...syncLedger.summarizeNotificationPayload(
          notifyType || "Notification",
          payloadTuple,
        ),
      });
      return;
    }
    // One recipient: the attribute values are converted for this session's
    // character, once, before the single encode. The logs and traces get the
    // caller's payload as it was.
    const innerMarshalStartedAtMs = Date.now();
    const marshalledPayload = ClientSession.encodeNotificationPayload(payloadTuple, {
      notifyType,
      readOwnAttributes: () => this.readOwnCharacterAttributes(),
    });
    return this.sendEncodedNotification(notifyType, idType, marshalledPayload, payloadTuple, {
      innerMarshalMs: Date.now() - innerMarshalStartedAtMs,
    });
  }

  /**
   * The inner payload of a broadcast notification, marshalled.
   *
   * With `notifyType`, the payload is first made what the game's own wire
   * carries for that notice (toWireNotificationPayload, with
   * `readOwnAttributes`), then encoded once: for a payload with one recipient.
   * Without it, the payload is encoded as given, never converted: the same
   * bytes for every recipient. A Grid bubble's Destiny batch is encoded once
   * so and sent to each of its Observers with sendEncodedNotification
   * (Server's choice).
   */
  static encodeNotificationPayload(payloadTuple = [], options = {}) {
    const { notifyType = null, readOwnAttributes = null } = options || {};
    const wirePayload = notifyType
      ? toWireNotificationPayload(notifyType, payloadTuple, { readOwnAttributes })
      : payloadTuple;
    return marshalEncode(buildBroadcastNotificationMarshalValue(wirePayload));
  }

  /**
   * sendNotification with its inner payload already marshalled
   * (encodeNotificationPayload); `payloadTuple` is the same payload unencoded,
   * for the logs and traces. Only the per-session envelope (the sequence
   * number, the user) is built here.
   */
  sendEncodedNotification(notifyType, idType, marshalledPayload, payloadTuple = [], details = {}) {
    if (!this.socket || this.socket.destroyed) {
      syncLedger.recordSyncLedgerEvent(this, "packet.dropped", {
        kind: "notification",
        notifyType: notifyType || "Notification",
        idType: idType || "ownerid",
        reason: "socket-closed",
        ...syncLedger.summarizeNotificationPayload(
          notifyType || "Notification",
          payloadTuple,
        ),
      });
      return;
    }

    // Source address: Node
    // C++: packet->source.type = PyAddress::Node; packet->source.objectID = m_services.GetNodeID();
    const sourceAddr = encodeAddress({
      type: "node",
      nodeID: PROXY_NODE_ID,
    });

    // Dest address: Broadcast
    // C++: dest.type = PyAddress::Broadcast; dest.service = notifyType; dest.bcast_idtype = idType; dest.objectID = GetClientID();
    const destAddr = encodeAddress({
      type: "broadcast",
      idtype: idType || "ownerid",
      broadcastID: notifyType, // ServiceCallGPCS expects notifyType to be the broadcastID
    });

    // TQ broadcast notifications wrap the object/RPC body in a leading 0
    // before the [1, args] call tuple (encodeNotificationPayload).
    const innerMarshalElapsedMs = Number(details && details.innerMarshalMs) || 0;

    const responseTuple = [
      MACHONETMSG_TYPE.NOTIFICATION,
      sourceAddr,
      destAddr,
      this.userid || null,
      [[0, marshalledPayload]], // payload argument: must double wrap because the Notification packet has 1 param 'payload'
      { type: "dict", entries: buildNotificationNamedPayloadEntries(this) }, // named payload
      null, // contextKey
      null, // traceID/bssid (8th element required)
      null, // spanID/bssctx (9th element required)
      null, // 10th
      null, // 11th
      null, // 12th
      null, // 13th
      null, // 14th
    ];

    const packet = {
      type: "object",
      name: "carbon.common.script.net.machoNetPacket.Notification",
      args: responseTuple,
    };
    const spatialTraceContext =
      (notifyType || "Notification") === "DoDestinyUpdate" && spatialTrace.isEnabled()
        ? spatialTrace.recordSerializedNotification(
          this,
          payloadTuple,
          marshalledPayload,
        )
        : null;

    log.pktOut(
      notifyType || "Notification",
      buildNotificationLogMessage(notifyType, idType, payloadTuple),
    );
    this._pendingBootstrapPacketPerf = {
      kind: "notification",
      notifyType: notifyType || "Notification",
      idType: idType || "ownerid",
      innerBytes: marshalledPayload.length,
      innerMarshalMs: innerMarshalElapsedMs,
      ...syncLedger.summarizeNotificationPayload(
        notifyType || "Notification",
        payloadTuple,
      ),
    };
    serviceCallShapeCapture.captureNotificationShape({
      lane: "broadcast",
      notifyType: notifyType || "Notification",
      idType: idType || "ownerid",
      payload: payloadTuple,
      session: this,
      innerBytes: marshalledPayload.length,
      innerMarshalMs: innerMarshalElapsedMs,
    });
    this.sendPacket(packet, spatialTraceContext);
  }

  /**
   * Send a MACHONETMSG_TYPE.NOTIFICATION to a specific client-side service.
   * This is required for notifications like `michelle.OnSlimItemChange`,
   * where the service must transform raw wire args before scattering them.
   */
  sendServiceNotification(serviceName, methodName, payloadTuple = [], kwargs = null) {
    if (!this.socket || this.socket.destroyed) {
      syncLedger.recordSyncLedgerEvent(this, "packet.dropped", {
        kind: "service-notification",
        service: serviceName || null,
        method: methodName,
        reason: "socket-closed",
        argCount: Array.isArray(payloadTuple) ? payloadTuple.length : 0,
      });
      return;
    }

    const sourceAddr = encodeAddress({
      type: "node",
      nodeID: PROXY_NODE_ID,
    });

    const destAddr = encodeAddress({
      // EVE's client-side service notifications target MachoAddress(service=...),
      // i.e. the wire form our local encoder aliases as type "service".
      type: "service",
      service: serviceName || null,
    });

    const unpickledPayload = kwargs
      ? [1, methodName, payloadTuple, kwargs]
      : [1, methodName, payloadTuple];
    const innerMarshalStartedAtMs = Date.now();
    const marshalledPayload = marshalEncode(unpickledPayload);
    const innerMarshalElapsedMs = Date.now() - innerMarshalStartedAtMs;

    const responseTuple = [
      MACHONETMSG_TYPE.NOTIFICATION,
      sourceAddr,
      destAddr,
      this.userid || null,
      [[0, marshalledPayload]],
      { type: "dict", entries: buildNotificationNamedPayloadEntries(this) },
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ];

    const packet = {
      type: "object",
      name: "carbon.common.script.net.machoNetPacket.Notification",
      args: responseTuple,
    };

    log.pktOut(serviceName || "Notification", `${methodName}()`);
    this._pendingBootstrapPacketPerf = {
      kind: "service-notification",
      service: serviceName || null,
      method: methodName,
      innerBytes: marshalledPayload.length,
      innerMarshalMs: innerMarshalElapsedMs,
      argCount: Array.isArray(payloadTuple) ? payloadTuple.length : 0,
    };
    serviceCallShapeCapture.captureNotificationShape({
      lane: "service",
      service: serviceName || null,
      method: methodName,
      payload: payloadTuple,
      kwargs,
      session: this,
      innerBytes: marshalledPayload.length,
      innerMarshalMs: innerMarshalElapsedMs,
    });
    this.sendPacket(packet);
  }

  /**
   * Send a MACHONETMSG_TYPE.CALL_REQ to a client-side service.
   *
   * TQ uses this lane for modal client callbacks such as agents.YesNo during
   * mission decline confirmation. The client answers with a CallRsp carrying
   * the same node callID.
   */
  sendClientCallRequest(serviceName, methodName, argsTuple = [], kwargs = null, options = {}) {
    if (!this.socket || this.socket.destroyed) {
      syncLedger.recordSyncLedgerEvent(this, "packet.dropped", {
        kind: "client-call-request",
        service: serviceName || null,
        method: methodName || null,
        reason: "socket-closed",
        argCount: Array.isArray(argsTuple) ? argsTuple.length : 0,
      });
      return null;
    }
    if (typeof serviceName !== "string" || serviceName.trim() === "") {
      return null;
    }
    if (typeof methodName !== "string" || methodName.trim() === "") {
      return null;
    }

    const normalizedArgs = Array.isArray(argsTuple) ? argsTuple : [];
    let callID = Number(options.callID) > 0
      ? Math.trunc(Number(options.callID))
      : 0;
    if (!callID) {
      this._nextServerCallID = Math.max(
        1,
        Math.trunc(Number(this._nextServerCallID || 610000)) + 1,
      );
      callID = this._nextServerCallID;
    }
    const machoTimeout =
      Number(options.machoTimeout) > 0
        ? Math.trunc(Number(options.machoTimeout))
        : 86400;

    const callBody = [
      1,
      methodName,
      normalizedArgs,
      kwargs || buildMarshalDict([]),
    ];

    const responseTuple = [
      MACHONETMSG_TYPE.CALL_REQ,
      encodeAddress({
        type: "node",
        nodeID: PROXY_NODE_ID,
        service: null,
        callID,
      }),
      encodeAddress({
        type: "client",
        clientID: this.clientID,
        callID: null,
        service: serviceName,
      }),
      this.userid || null,
      [[0, { type: "substream", value: callBody }]],
      buildMarshalDict(buildClientCallNamedPayloadEntries(machoTimeout)),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ];

    const packet = {
      type: "object",
      name: "carbon.common.script.net.machoNetPacket.CallReq",
      args: responseTuple,
    };

    log.pktOut(serviceName, `${methodName}() client-call callID=${callID}`);
    if (!this._pendingClientCallRequests) {
      this._pendingClientCallRequests = new Map();
    }
    this._pendingClientCallRequests.set(callID, {
      service: serviceName,
      method: methodName,
      args: normalizedArgs,
      sentAtMs: Date.now(),
      machoTimeout,
      onResponse:
        typeof options.onResponse === "function"
          ? options.onResponse
          : null,
    });
    this._pendingBootstrapPacketPerf = {
      kind: "client-call-request",
      service: serviceName,
      method: methodName,
      callID,
      argCount: normalizedArgs.length,
      machoTimeout,
    };
    this.sendPacket(packet);
    return callID;
  }

  consumeClientCallResponse(packet) {
    if (!this._pendingClientCallRequests) {
      return null;
    }

    const callID = Number(
      packet && packet.dest && packet.dest.callID
        ? packet.dest.callID
        : packet && packet.source && packet.source.callID
          ? packet.source.callID
          : 0,
    );
    if (!callID || !this._pendingClientCallRequests.has(callID)) {
      return null;
    }

    const pending = this._pendingClientCallRequests.get(callID);
    this._pendingClientCallRequests.delete(callID);
    const packetPayload = packet ? packet.payload : null;
    // GPCS wraps a client-call result twice: MachoPacket's one-item body tuple,
    // then ObjectCallGPCS's marshaled return substream. Remove only those wire
    // layers; containers inside the substream belong to the RPC return value.
    const bodyResponse = Array.isArray(packetPayload) && packetPayload.length === 1
      ? packetPayload[0]
      : packetPayload;
    const response =
      bodyResponse &&
      typeof bodyResponse === "object" &&
      bodyResponse.type === "substream" &&
      Object.prototype.hasOwnProperty.call(bodyResponse, "value")
        ? bodyResponse.value
        : bodyResponse;
    return {
      ...pending,
      callID,
      response,
      receivedAtMs: Date.now(),
    };
  }

  /**
   * Send a MACHONETMSG_TYPE.NOTIFICATION to a bound client-side object.
   * This uses the object-call notification lane rather than exported service
   * notifications, which is required for methods like `Michelle.OnDbuffUpdated`.
   */
  sendObjectNotification(objectID, methodName, payloadTuple = [], kwargs = null) {
    if (!this.socket || this.socket.destroyed) {
      syncLedger.recordSyncLedgerEvent(this, "packet.dropped", {
        kind: "object-notification",
        objectID,
        method: methodName,
        reason: "socket-closed",
        argCount: Array.isArray(payloadTuple) ? payloadTuple.length : 0,
      });
      return;
    }
    if (typeof objectID !== "string" || objectID.trim() === "") return;
    if (typeof methodName !== "string" || methodName.trim() === "") return;

    const sourceAddr = encodeAddress({
      type: "node",
      nodeID: PROXY_NODE_ID,
    });

    const destAddr = encodeAddress({
      // Bound-object notifications ride the object-call lane, not the
      // broadcast/service wrapper. Route them as node-bound notifications so
      // the client enters ObjectCallGPCS.NotifyUp and resolves the object ID
      // directly instead of falling through to BroadcastStuff.
      type: "node",
      nodeID: PROXY_NODE_ID,
      service: null,
    });

    const objectPayload = kwargs
      ? [objectID, methodName, payloadTuple, kwargs]
      : [objectID, methodName, payloadTuple];
    const marshalledObjectPayload = marshalEncode(objectPayload);
    const objectRegistrationRefID = resolveBoundObjectRegistrationRefID(
      this,
      objectID,
    );
    const namedPayloadEntries = buildNotificationNamedPayloadEntries(this);
    namedPayloadEntries.push([
      "OID+",
      {
        type: "dict",
        entries: [[objectID, objectRegistrationRefID]],
      },
    ]);

    const responseTuple = [
      MACHONETMSG_TYPE.NOTIFICATION,
      sourceAddr,
      destAddr,
      this.userid || null,
      [[1, marshalledObjectPayload]],
      { type: "dict", entries: namedPayloadEntries },
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ];

    const packet = {
      type: "object",
      name: "carbon.common.script.net.machoNetPacket.Notification",
      args: responseTuple,
    };

    log.pktOut(objectID, `${methodName}()`);
    this._pendingBootstrapPacketPerf = {
      kind: "object-notification",
      objectID,
      method: methodName,
      innerBytes: marshalledObjectPayload.length,
      argCount: Array.isArray(payloadTuple) ? payloadTuple.length : 0,
    };
    serviceCallShapeCapture.captureNotificationShape({
      lane: "object",
      objectID,
      method: methodName,
      payload: payloadTuple,
      kwargs,
      session: this,
      innerBytes: marshalledObjectPayload.length,
    });
    this.sendPacket(packet);
  }

  /**
   * Get a summary of this session for logging.
   */
  toString() {
    return `[Session ${this.address} user=${this.userName}(${this.userid}) char=${this.characterName}(${this.characterID})]`;
  }
}

ClientSession._testing = {
  buildBroadcastNotificationMarshalValue,
};

module.exports = ClientSession;
