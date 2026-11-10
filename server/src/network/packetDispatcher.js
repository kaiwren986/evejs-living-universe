"use strict";

/**
 * EVE Packet Dispatcher
 *
 * Ported from EVEPktDispatch.cpp — routes decoded PyPackets by their type
 * to the appropriate handler. After the handshake completes, every incoming
 * packet from the client is a macho PyPacket that ends up here.
 */

const path = require("path");
const { resolveDataRootPath } = require(path.join(__dirname, "../config/dataRoot"));
const log = require(path.join(__dirname, "../utils/logger"));
const rotatingLog = require(path.join(__dirname, "../utils/rotatingLog"));
const { MACHONETMSG_TYPE, getTypeName } = require(
  path.join(__dirname, "../common/packetTypes"),
);
const {
  MachoWrappedException,
  buildCacheOkMachoError,
  buildUserErrorPayload,
  getMachoUserErrorMessage,
  isCacheOkMachoError,
  isMachoWrappedException,
  isUserErrorMachoError,
} = require(
  path.join(__dirname, "../common/machoErrors"),
);
const { decodePacket, decodeCallRequest, encodePacketTuple } = require(
  path.join(__dirname, "../common/pyPacket"),
);
const { encodeAddress } = require(
  path.join(__dirname, "../common/machoAddress"),
);
const {
  isDeferredCallResponse,
} = require(path.join(__dirname, "./callResponseControl"));
const serviceCallShapeCapture = require(path.join(
  __dirname,
  "../services/_shared/serviceCallShapeCapture",
));
const marshalWorkerPool = require(path.join(
  __dirname,
  "./marshalWorkerPool",
));
const {
  shouldReturnCacheOkForCachedMethodCall,
} = require(path.join(__dirname, "../services/cache/objectCacheRuntime"));
const { PROXY_NODE_ID } = require(path.join(__dirname, "./protocolProfile"));
const slashDebugPath = resolveDataRootPath("logs", "slash-debug.log");
const spaceDebugPath = resolveDataRootPath("logs", "space-undock-debug.log");

function appendSlashDebug(entry) {
  if (!log.isVerboseDebugEnabled()) {
    return;
  }
  try {
    rotatingLog.append(slashDebugPath, `[${new Date().toISOString()}] ${entry}\n`);
  } catch (error) {
    log.warn(`[PacketDispatcher] Failed to write slash debug log: ${error.message}`);
  }
}

function appendSpaceDebug(entry) {
  if (!log.isVerboseDebugEnabled()) {
    return;
  }
  try {
    rotatingLog.append(spaceDebugPath, `[${new Date().toISOString()}] ${entry}\n`);
  } catch (error) {
    log.warn(`[PacketDispatcher] Failed to write space debug log: ${error.message}`);
  }
}

function summarizeValue(value, depth = 0) {
  if (depth > 4) {
    return "<max-depth>";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Buffer.isBuffer(value)) {
    return `<Buffer:${value.toString("utf8")}>`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => summarizeValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const summary = {};
    for (const [key, entryValue] of Object.entries(value)) {
      summary[key] = summarizeValue(entryValue, depth + 1);
    }
    return summary;
  }

  return String(value);
}

function extractBoundObjectName(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value.startsWith("N=") ? value : null;
  }

  if (Buffer.isBuffer(value)) {
    const decoded = value.toString("utf8");
    return decoded.startsWith("N=") ? decoded : null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = extractBoundObjectName(entry, depth + 1);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }

  if (typeof value === "object") {
    if (typeof value.value === "string" && value.value.startsWith("N=")) {
      return value.value;
    }
    if (Buffer.isBuffer(value.value)) {
      const decoded = value.value.toString("utf8");
      if (decoded.startsWith("N=")) {
        return decoded;
      }
    }

    const fieldsToCheck = [
      value.value,
      value.args,
      value.remoteObject,
      value.objectID,
      value.id,
    ];
    for (const field of fieldsToCheck) {
      const resolved = extractBoundObjectName(field, depth + 1);
      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

function extractBoundObjectRegistrations(result) {
  const registrations = new Map();
  collectBoundObjectRegistrations(result, registrations);
  return [...registrations.entries()];
}

function collectBoundObjectIDs(value, output, depth = 0) {
  if (depth > 8 || value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    if (value.startsWith("N=")) {
      output.add(value);
    }
    return;
  }
  if (Buffer.isBuffer(value)) {
    const decoded = value.toString("utf8");
    if (decoded.startsWith("N=")) {
      output.add(decoded);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectBoundObjectIDs(entry, output, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  if (value.type === "dict" && Array.isArray(value.entries)) {
    for (const [entryKey] of value.entries) {
      collectBoundObjectIDs(entryKey, output, depth + 1);
    }
    return;
  }
  if (value instanceof Map) {
    for (const entryKey of value.keys()) {
      collectBoundObjectIDs(entryKey, output, depth + 1);
    }
    return;
  }
  if (Object.prototype.hasOwnProperty.call(value, "value")) {
    collectBoundObjectIDs(value.value, output, depth + 1);
    return;
  }
  for (const entryKey of Object.keys(value)) {
    collectBoundObjectIDs(entryKey, output, depth + 1);
  }
}

function extractReleasedBoundObjectIDs(pkt, decodedNotification) {
  const released = new Set();
  if (decodedNotification) {
    collectBoundObjectIDs(decodedNotification.remoteObject, released);
  }
  for (const namedPayload of [pkt && pkt.namedPayload, pkt && pkt.oob]) {
    for (const [entryKey, entryValue] of extractDictEntries(namedPayload)) {
      if (String(entryKey) === "OID-") {
        collectBoundObjectIDs(entryValue, released);
      }
    }
  }
  return [...released];
}

// OID- maps each released object to the refID of the newest bind the client
// still knew about (ObjectCallGPCS.__ReleaseObjectHelper). Objects named only
// by the notification's remoteObject carry no refID and map to null.
function extractReleasedBoundObjectRefIDs(pkt) {
  const refIDs = new Map();
  for (const namedPayload of [pkt && pkt.namedPayload, pkt && pkt.oob]) {
    for (const [entryKey, entryValue] of extractDictEntries(namedPayload)) {
      if (String(entryKey) !== "OID-") {
        continue;
      }
      for (const [objectID, refID] of extractDictEntries(entryValue)) {
        const oid = Buffer.isBuffer(objectID) ? objectID.toString("utf8") : objectID;
        if (typeof oid === "string" && oid.startsWith("N=")) {
          refIDs.set(oid, normalizeBoundObjectRefID(refID));
        }
      }
    }
  }
  return refIDs;
}

function normalizeBoundObjectRefID(value) {
  const raw = value && typeof value === "object" && "value" in value ? value.value : value;
  try {
    if (typeof raw === "bigint") {
      return raw;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return BigInt(Math.trunc(raw));
    }
  } catch {
    // fall through
  }
  return null;
}

function collectBoundObjectRegistrations(value, registrations) {
  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectBoundObjectRegistrations(entry, registrations);
    }
    return;
  }

  if (typeof value !== "object" || value.type !== "substruct") {
    return;
  }

  const substream = value.value;
  const objectRegistration =
    substream && substream.type === "substream"
      ? substream.value
      : substream;

  if (
    Array.isArray(objectRegistration) &&
    typeof objectRegistration[0] === "string" &&
    objectRegistration[0].startsWith("N=")
  ) {
    registrations.set(objectRegistration[0], objectRegistration[1] ?? null);
  }
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
      `[PacketDispatcher] Failed to record space bootstrap trace: ${error.message}`,
    );
  }
  return false;
}

function extractDictEntries(value) {
  if (!value) {
    return [];
  }
  if (value.type === "dict" && Array.isArray(value.entries)) {
    return [...value.entries];
  }
  if (value instanceof Map) {
    return [...value.entries()];
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value);
  }
  return [];
}

function buildNamedPayloadDict(entries = []) {
  return {
    type: "dict",
    entries: Array.isArray(entries) ? entries : [],
  };
}

function mergeNamedPayloadEntries(existingNamedPayload, extraEntries = []) {
  const existingEntries = extractDictEntries(existingNamedPayload);
  const mergedEntries = [...existingEntries];
  for (const [entryKey, entryValue] of extraEntries) {
    mergedEntries.push([entryKey, entryValue]);
  }
  return buildNamedPayloadDict(mergedEntries);
}

function mergeBoundObjectRegistrationsIntoNamedPayload(existingNamedPayload, registrations = []) {
  if (!Array.isArray(registrations) || registrations.length === 0) {
    return buildNamedPayloadDict(extractDictEntries(existingNamedPayload));
  }

  const existingEntries = extractDictEntries(existingNamedPayload);
  const oidRegistrationEntries = new Map();
  const mergedEntries = [];
  let hasOidEntry = false;

  for (const [entryKey, entryValue] of existingEntries) {
    if (String(entryKey) !== "OID+") {
      mergedEntries.push([entryKey, entryValue]);
      continue;
    }
    hasOidEntry = true;
    for (const [objectID, refID] of extractDictEntries(entryValue)) {
      if (typeof objectID === "string" && objectID.startsWith("N=")) {
        oidRegistrationEntries.set(objectID, refID ?? null);
      }
    }
  }

  for (const [objectID, refID] of registrations) {
    if (typeof objectID === "string" && objectID.startsWith("N=")) {
      oidRegistrationEntries.set(objectID, refID ?? null);
    }
  }

  if (!hasOidEntry || oidRegistrationEntries.size > 0) {
    mergedEntries.push([
      "OID+",
      {
        type: "dict",
        entries: [...oidRegistrationEntries.entries()],
      },
    ]);
  }

  return buildNamedPayloadDict(mergedEntries);
}

function normalizeObjectName(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (typeof value === "object") {
    if (value.type === "rawstr" || value.type === "wstring" || value.type === "token") {
      return String(value.value ?? "");
    }
    if (value.value !== undefined && typeof value.value !== "object") {
      return String(value.value ?? "");
    }
  }
  return String(value);
}

function extractCachedObjectCompressedPart(value, seen = new Set()) {
  if (!value || typeof value !== "object") {
    return 0;
  }
  if (seen.has(value)) {
    return 0;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.reduce(
      (total, entry) => total + extractCachedObjectCompressedPart(entry, seen),
      0,
    );
  }

  if (value.type === "object") {
    const objectName = normalizeObjectName(value.name);
    if (
      objectName === "objectCaching.CachedObject" ||
      objectName === "carbon.common.script.net.objectCaching.CachedObject"
    ) {
      const args = Array.isArray(value.args) ? value.args : [];
      const pickle = args[4];
      const compressed = Number(args[5]) === 1;
      if (compressed && pickle && pickle.type === "bytes") {
        const pickleValue = pickle.value;
        if (Buffer.isBuffer(pickleValue)) {
          return pickleValue.length;
        }
        if (typeof pickleValue === "string") {
          return Buffer.byteLength(pickleValue, "binary");
        }
      }
    }
  }

  let total = 0;
  for (const entryValue of Object.values(value)) {
    total += extractCachedObjectCompressedPart(entryValue, seen);
  }
  return total;
}

function buildCallResponseSourceAddress(pkt, responseServiceName) {
  const destination = pkt && pkt.dest ? pkt.dest : {};
  const service = responseServiceName || destination.service || null;
  const sourceCallID = destination.callID || null;
  if (destination.type === "any") {
    return {
      type: "any",
      service,
      callID: sourceCallID,
    };
  }
  return {
    type: "node",
    nodeID: destination.type === "node" && destination.nodeID != null
      ? destination.nodeID
      : PROXY_NODE_ID,
    service,
    callID: sourceCallID,
  };
}

class PacketDispatcher {
  constructor(serviceManager) {
    this.serviceManager = serviceManager;
  }

  /**
   * Dispatch a decoded marshal value (the raw tuple from the wire).
   * Returns true if the packet was handled.
   */
  async dispatch(rawDecoded, session) {
    const pkt = decodePacket(rawDecoded);
    if (!pkt) {
      log.warn("[PacketDispatcher] Could not decode raw packet into PyPacket");
      log.debug(
        `[PacketDispatcher] Raw type: ${typeof rawDecoded}, keys: ${rawDecoded && typeof rawDecoded === "object" ? Object.keys(rawDecoded).join(",") : "N/A"}`,
      );
      return false;
    }

    log.pktIn(
      pkt.service || pkt.typeName,
      `${pkt.typeName} src=${pkt.source.type} dst=${pkt.dest.type}`,
    );

    if (pkt.type !== MACHONETMSG_TYPE.CALL_REQ) {
      serviceCallShapeCapture.capturePacketShape({
        direction: "inbound",
        rawDecoded,
        packet: pkt,
        session,
      });
    }

    switch (pkt.type) {
      case MACHONETMSG_TYPE.CALL_REQ:
        return this._handleCallReq(pkt, session, rawDecoded);

      case MACHONETMSG_TYPE.CALL_RSP:
        return this._handleCallRsp(pkt, session);

      case MACHONETMSG_TYPE.NOTIFICATION:
        return this._handleNotification(pkt, session);

      case MACHONETMSG_TYPE.PING_REQ:
        return this._handlePingReq(pkt, session);

      case MACHONETMSG_TYPE.PING_RSP:
        return this._handlePingRsp(pkt, session);

      case MACHONETMSG_TYPE.SESSIONCHANGENOTIFICATION:
        return this._handleSessionChange(pkt, session);

      case MACHONETMSG_TYPE.ERRORRESPONSE:
        return this._handleErrorResponse(pkt, session);

      default:
        return this._handleOther(pkt, session);
    }
  }

  async _handleCallReq(pkt, session, rawDecoded = null) {
    let serviceName = pkt.service || pkt.dest.service;
    const call = decodeCallRequest(pkt.payload);

    // EVE 23.02: For bound object calls, the service name is null in the address,
    // but the OID string (e.g. "N=1:5") is in the call body's remoteObject field.
    if (!serviceName && call.remoteObject) {
      serviceName = extractBoundObjectName(call.remoteObject) || serviceName;
    }

    // EVE 23.02: Client places its callID in the source address (e.g. [2, 0, 1, null] -> callID=1)
    // The dest address might contain proxyNodeId at index 1 instead of callID.
    const callID = pkt.source.callID || pkt.dest.callID || 0;

    log.pktIn(
      serviceName || "?",
      `${call.method}() callID=${callID}`,
    );
    const lookedUpService =
      this.serviceManager && serviceName
        ? this.serviceManager.lookup(serviceName, session)
        : null;
    const resolvedServiceName = lookedUpService ? lookedUpService.name : serviceName;
    const lowerResolvedServiceName = String(
      resolvedServiceName || serviceName || "",
    ).toLowerCase();
    const lowerMethodName = String(call.method || "").toLowerCase();
    serviceCallShapeCapture.capturePacketShape({
      direction: "inbound",
      rawDecoded,
      packet: pkt,
      context: {
        kind: "call-request",
        service: resolvedServiceName || serviceName || null,
        method: call.method,
        callID,
      },
      session,
    });
    const traceSpaceCall =
      call.method === "Undock" ||
      resolvedServiceName === "beyonce" ||
      (resolvedServiceName === "ship" && call.method === "MachoBindObject") ||
      lowerMethodName.includes("homestation") ||
      lowerMethodName.includes("home_station") ||
      lowerResolvedServiceName.includes("home_station") ||
      lowerResolvedServiceName.includes("homestation") ||
      lowerResolvedServiceName.includes("homestation");
    if (traceSpaceCall) {
      appendSpaceDebug(
        `CallReq service=${resolvedServiceName || serviceName || "?"} rawService=${serviceName || "?"} method=${call.method} callID=${callID} currentBound=${session && session.currentBoundObjectID ? session.currentBoundObjectID : "null"} args=${JSON.stringify(summarizeValue(call.args))} kwargs=${JSON.stringify(summarizeValue(call.kwargs))}`,
      );
    }
    if (serviceName === "slash") {
      appendSlashDebug(
        `CallReq method=${call.method} callID=${callID} args=${JSON.stringify(summarizeValue(call.args))} kwargs=${JSON.stringify(summarizeValue(call.kwargs))} raw=${JSON.stringify(summarizeValue(call.raw))}`,
      );
    }

    if (this.serviceManager && serviceName) {
      const service = lookedUpService;
      if (service) {
        const previousBoundObjectID = session
          ? session.currentBoundObjectID
          : null;
        try {
          // A previous hazard can have committed a receipt while its health
          // publication or dungeon acknowledgement failed. Settle that exact
          // hull before another client command can move, repair or save it.
          require("../services/dungeon/siteHazardOutcomes").recoverForSession(session);
          if (session) {
            session.currentBoundObjectID =
              typeof serviceName === "string" && serviceName.startsWith("N=")
                ? serviceName
                : null;
          }
          const handlerStartedAtMs = Date.now();
          const result = await marshalWorkerPool.runWithOffloadContext(
            () => service.callMethod(
              call.method,
              call.args,
              session,
              call.kwargs,
              {
                callID,
                requestScope: Number(callID) > 0 && session && (session.sessionID ?? session.sid)
                  ? `${String(session.sessionID ?? session.sid)}:${callID}`
                  : null,
              },
            ),
          );
          const handlerElapsedMs = Date.now() - handlerStartedAtMs;
          recordSpaceBootstrapTrace(session, "service-call", {
            service: service.name || resolvedServiceName || serviceName || "?",
            method: call.method,
            callID,
            handlerMs: handlerElapsedMs,
            argCount: Array.isArray(call.args) ? call.args.length : 0,
          });
          if (handlerElapsedMs >= 100) {
            log.info(
              `[PacketPerf] service=${service.name || resolvedServiceName || serviceName || "?"} ` +
              `method=${call.method} callID=${callID} handlerMs=${handlerElapsedMs}`,
            );
          }

          if (isDeferredCallResponse(result)) {
            if (typeof result.start === "function") {
              await result.start({
                dispatcher: this,
                packet: pkt,
                session,
                service,
                call,
                responseServiceName:
                  service.name || resolvedServiceName || serviceName || null,
                responsePerfMeta: {
                  kind: "call-response",
                  service:
                    service.name || resolvedServiceName || serviceName || null,
                  method: call.method,
                  callID,
                },
              });
            }
            return true;
          }

          if (shouldReturnCacheOkForCachedMethodCall(result, call.kwargs)) {
            this._sendErrorResponse(
              pkt,
              buildCacheOkMachoError(),
              session,
              service.name || resolvedServiceName || serviceName || null,
            );
            return true;
          }

          // Scan results for bound object OIDs and register them
          // so future calls to those OIDs route back to this service.
          this._scanAndRegisterOIDs(result, service, session);
          if (traceSpaceCall) {
            appendSpaceDebug(
              `CallRsp service=${service.name} method=${call.method} callID=${callID} result=${JSON.stringify(summarizeValue(result))}`,
            );
          }

          // Always send a response, even if result is null/undefined
          this._sendCallResponse(
            pkt,
            result !== undefined ? result : null,
            session,
            service.name || resolvedServiceName || serviceName || null,
            {
              kind: "call-response",
              service: service.name || resolvedServiceName || serviceName || null,
              method: call.method,
              callID,
            },
          );
          if (typeof service.afterCallResponse === "function") {
            try {
              const afterCallStartedAtMs = Date.now();
              await service.afterCallResponse(call.method, session, {
                args: call.args,
                kwargs: call.kwargs,
                result,
                packet: pkt,
              });
              const afterCallElapsedMs = Date.now() - afterCallStartedAtMs;
              recordSpaceBootstrapTrace(session, "service-after-call-response", {
                service: service.name || resolvedServiceName || serviceName || "?",
                method: call.method,
                callID,
                afterCallMs: afterCallElapsedMs,
              });
              if (afterCallElapsedMs >= 100) {
                log.info(
                  `[PacketPerf] afterCall service=${service.name || resolvedServiceName || serviceName || "?"} ` +
                  `method=${call.method} callID=${callID} afterCallMs=${afterCallElapsedMs}`,
                );
              }
            } catch (afterCallError) {
              log.warn(
                `[PacketDispatcher] afterCallResponse failed for ${service.name}.${call.method}: ${afterCallError.message}`,
              );
            }
          }
          return true;
        } catch (err) {
          if (typeof service.afterCallFailure === "function") {
            service.afterCallFailure(call.method, session, { args: call.args });
          }
          const wrappedMachoError = isMachoWrappedException(err)
            ? err.machoErrorResponse
            : null;
          if (isUserErrorMachoError(wrappedMachoError)) {
            log.debug(
              `[PacketDispatcher] expected UserError service=${service.name || resolvedServiceName || serviceName || "?"} ` +
                `method=${call.method} callID=${callID} ` +
                `message=${getMachoUserErrorMessage(wrappedMachoError) || "UserError"}`,
            );
          } else {
            log.pktErr(
              serviceName || "?",
              `${call.method}() ${err.message}`,
            );
          }
          if (traceSpaceCall) {
            appendSpaceDebug(
              `CallErr service=${service.name} method=${call.method} callID=${callID} error=${err && err.stack ? err.stack : err.message}`,
            );
          }
          if (isMachoWrappedException(err)) {
            this._sendErrorResponse(
              pkt,
              err.machoErrorResponse,
              session,
              service.name || resolvedServiceName || serviceName || null,
            );
          } else {
            this._sendCallResponse(
              pkt,
              null,
              session,
              service.name || resolvedServiceName || serviceName || null,
              {
                kind: "call-response",
                service: service.name || resolvedServiceName || serviceName || null,
                method: call.method,
                callID,
              },
            );
          }
          return true;
        } finally {
          if (session) {
            session.currentBoundObjectID = previousBoundObjectID || null;
          }
        }
      } else {
        log.pktErr(serviceName, "no service registered");
        if (typeof serviceName === "string" && serviceName.startsWith("N=")) {
          // A released bound object. A None reply is read as the call's result
          // (clientPlanet._PrimeColony dies on None.level); UnMachoDestination
          // makes the client's Moniker unresolve, rebind and retry once.
          this._sendErrorResponse(
            pkt,
            new MachoWrappedException(buildUserErrorPayload("UnMachoDestination"))
              .machoErrorResponse,
            session,
            serviceName,
          );
          return true;
        }
        // Send None response so client doesn't hang
        this._sendCallResponse(
          pkt,
          null,
          session,
          resolvedServiceName || serviceName || null,
        );
      }
    } else {
      log.pktErr("CallReq", "no service name in packet");
      this._sendCallResponse(pkt, null, session);
    }

    return true;
  }

  async _handleCallRsp(pkt, session) {
    const clientCallResponse =
      session && typeof session.consumeClientCallResponse === "function"
        ? session.consumeClientCallResponse(pkt)
        : null;
    if (clientCallResponse) {
      log.pktIn(
        clientCallResponse.service || "CallRsp",
        `${clientCallResponse.method || "client-call"}() response callID=${clientCallResponse.callID}`,
      );
      if (typeof clientCallResponse.onResponse === "function") {
        try {
          await clientCallResponse.onResponse(clientCallResponse, {
            packet: pkt,
            session,
            dispatcher: this,
          });
        } catch (error) {
          log.warn(
            `[PacketDispatcher] client CallRsp callback failed for ${clientCallResponse.service || "?"}.${clientCallResponse.method || "?"}: ${error.message}`,
          );
        }
      }
      return true;
    }

    log.pktIn("CallRsp", "client → server (unusual)");
    return true;
  }

  _handleNotification(pkt, session) {
    const hasObjectReleaseMetadata = [pkt && pkt.namedPayload, pkt && pkt.oob]
      .some((payload) => extractDictEntries(payload)
        .some(([entryKey]) => String(entryKey) === "OID-"));
    const notification = hasObjectReleaseMetadata
      ? decodeCallRequest(pkt.payload)
      : null;
    if (notification && notification.method === "ClientHasReleasedTheseObjects") {
      const releasedObjectIDs = extractReleasedBoundObjectIDs(pkt, notification);
      const releasedRefIDs = extractReleasedBoundObjectRefIDs(pkt);
      let releasedCount = 0;
      const releaseDetail = [];
      for (const objectID of releasedObjectIDs) {
        const releasedRefID = releasedRefIDs.has(objectID)
          ? releasedRefIDs.get(objectID)
          : null;
        const released = Boolean(
          this.serviceManager &&
          typeof this.serviceManager.unregisterBoundObject === "function" &&
          this.serviceManager.unregisterBoundObject(objectID, { session, releasedRefID }),
        );
        if (released) {
          releasedCount += 1;
        }
        releaseDetail.push(
          `${objectID}@${releasedRefID === null ? "?" : releasedRefID}${released ? "" : "(kept)"}`,
        );
      }
      log.pktIn(
        "Notification",
        `ClientHasReleasedTheseObjects released=${releasedCount}/${releasedObjectIDs.length} ${releaseDetail.join(" ")}`,
      );
      return true;
    }

    log.pktIn("Notification", pkt.dest.broadcastID || "?");
    return true;
  }

  _handlePingReq(pkt, session) {
    log.pktIn("Ping", "request received");
    log.pktOut("Ping", "response sent");

    const now = BigInt(Date.now()) * 10000n + 116444736000000000n; // Win32 FILETIME

    // Build ping response with timing data like EVEmu
    const pingList = {
      type: "list",
      items: [
        [now - 20n, now, "proxy::handle_message"],
        [now - 20n, now, "proxy::writing"],
        [now - 20n, now, "server::handle_message"],
        [now - 20n, now, "server::turnaround"],
        [now - 20n, now, "proxy::handle_message"],
        [now - 20n, now, "proxy::writing"],
      ],
    };

    // Build response as PyObject("macho.PingRsp", tuple)
    const responseTuple = [
      MACHONETMSG_TYPE.PING_RSP, // type
      encodeAddress(pkt.dest), // swap src/dst
      encodeAddress(pkt.source),
      pkt.userID || null,
      [pingList], // payload
      { type: "dict", entries: [] }, // named payload
      pkt.oob || null, // contextKey
      pkt.bssid || null, // traceID/bssid (8th element required)
      pkt.spanid || null, // spanID/bssctx (9th element required)
      pkt.extra9 || null, // 10th
      pkt.extra10 || null, // 11th
      pkt.extra11 || null, // 12th
      pkt.extra12 || null, // 13th
      pkt.extra13 || null, // 14th
    ];

    const responseObj = {
      type: "object",
      name: "carbon.common.script.net.machoNetPacket.PingRsp",
      args: responseTuple,
    };

    if (session && session.sendPacket) {
      session.sendPacket(responseObj);
    }
    return true;
  }

  _handlePingRsp(pkt, session) {
    log.pktIn("Ping", "response from client");
    return true;
  }

  _handleSessionChange(pkt, session) {
    log.pktIn("SessionChange", "notification from client");
    return true;
  }

  _handleErrorResponse(pkt, session) {
    log.pktErr("ErrorResponse", "received error from client");
    return true;
  }

  _handleOther(pkt, session) {
    log.pktErr("Dispatch", `unhandled packet type: ${pkt.typeName} (${pkt.type})`);
    return false;
  }

  /**
   * Send a CALL_RSP back to the client.
   *
   * Matches C++ PyPacket::Encode() format:
   *   PyObject("macho.CallRsp", [type, source, dest, userID, payload, namedPayload, oob])
   *
   * Where:
   *   source = PyObject("macho.MachoAddress", [2, nodeID, service, callID])
   *   dest   = PyObject("macho.MachoAddress", [3, clientID, 0, null])
   *   payload = [substream(result)] by default; selected provisional replies
   *             carry their result directly when the caller requests it
   *   namedPayload = {} (empty dict)
   */
  _sendCallResponse(
    pkt,
    result,
    session,
    responseServiceName = null,
    responsePerfMeta = null,
    responseOptions = {},
  ) {
    if (!session || !session.sendPacket) return;
    const normalizedResponseOptions =
      responseOptions && typeof responseOptions === "object"
        ? responseOptions
        : {};

    // The callID comes from the source address of the request
    const callID = pkt.source.callID || pkt.dest.callID || 0;
    const boundObjectRegistrations = extractBoundObjectRegistrations(result);
    const compressedPart = extractCachedObjectCompressedPart(result);
    let responseNamedPayload = mergeNamedPayloadEntries(
      null,
      Array.isArray(normalizedResponseOptions.namedPayloadEntries)
        ? normalizedResponseOptions.namedPayloadEntries
        : [],
    );
    responseNamedPayload = mergeBoundObjectRegistrationsIntoNamedPayload(
      responseNamedPayload,
      boundObjectRegistrations,
    );
    if (compressedPart > 0) {
      responseNamedPayload = mergeNamedPayloadEntries(responseNamedPayload, [
        ["compressedPart", compressedPart],
      ]);
    }
    const contextKey =
      Object.prototype.hasOwnProperty.call(normalizedResponseOptions, "contextKey")
        ? normalizedResponseOptions.contextKey
        : pkt.oob || null;
    const responsePayload =
      normalizedResponseOptions.wrapResultInSubstream === false
        ? [result]
        : [{ type: "substream", value: result }];

    // Build the 7-element tuple
    const responseTuple = [
      MACHONETMSG_TYPE.CALL_RSP, // type = 7

      // Source mirrors the request destination address shape. TQ answers
      // Address::Any service calls from Address::Any, and node calls from the
      // addressed node.
      encodeAddress(buildCallResponseSourceAddress(pkt, responseServiceName)),

      // Dest = client
      encodeAddress({
        ...pkt.source,
        callID: callID,
        service: null,
      }),

      // userID
      session.userid || pkt.userID || null,

      // MachoPacket body tuple. Normal call results travel in a substream;
      // TQ's agent provisional response is the direct empty tuple instead.
      responsePayload,

      // namedPayload / OOB dict. TQ carries OID+, provisional, and
      // compressedPart here; contextKey is the next tuple slot.
      responseNamedPayload,

      // contextKey
      contextKey,

      // traceID/bssid (8th element required)
      pkt.bssid || null,

      // spanID/bssctx (9th element required)
      pkt.spanid || null,
      pkt.extra9 || null, // 10th
      pkt.extra10 || null, // 11th
      pkt.extra11 || null, // 12th
      pkt.extra12 || null, // 13th
      pkt.extra13 || null, // 14th
    ];

    // Wrap in PyObject to match C++ PyPacket::Encode()
    const responseObj = {
      type: "object",
      name: "carbon.common.script.net.machoNetPacket.CallRsp",
      args: responseTuple,
    };

    log.pktOut(
      pkt.dest.service || pkt.service || "CallRsp",
      `response callID=${callID}`,
    );
    session._pendingBootstrapPacketPerf = responsePerfMeta || {
      kind: "call-response",
      service: responseServiceName || pkt.dest.service || pkt.service || null,
      callID,
    };
    session.sendPacket(responseObj);
  }

  _sendErrorResponse(pkt, machoError, session, responseServiceName = null) {
    if (!session || !session.sendPacket) return;

    const callID = pkt.source.callID || pkt.dest.callID || 0;
    const isCacheOk = isCacheOkMachoError(machoError);
    const userErrorMessage = getMachoUserErrorMessage(machoError);
    const responseTuple = [
      MACHONETMSG_TYPE.ERRORRESPONSE,
      encodeAddress({
        ...pkt.dest,
        service: responseServiceName || pkt.dest.service || null,
      }),
      encodeAddress({
        ...pkt.source,
        callID,
        service: null,
      }),
      session.userid || pkt.userID || null,
      [
        MACHONETMSG_TYPE.CALL_REQ,
        machoError && machoError.errorCode !== undefined
          ? machoError.errorCode
          : 2,
        [{ type: "substream", value: machoError ? machoError.payload : null }],
      ],
      { type: "dict", entries: [] },
      pkt.oob || null,
      pkt.bssid || null,
      pkt.spanid || null,
      pkt.extra9 || null,
      pkt.extra10 || null,
      pkt.extra11 || null,
      pkt.extra12 || null,
      pkt.extra13 || null,
    ];

    const responseObj = {
      type: "object",
      name: "carbon.common.script.net.machoNetPacket.ErrorResponse",
      args: responseTuple,
    };

    if (isCacheOk) {
      log.pktOut(
        pkt.dest.service || pkt.service || "ErrorRsp",
        `cacheOK callID=${callID}`,
      );
    } else if (isUserErrorMachoError(machoError)) {
      log.pktOut(
        pkt.dest.service || pkt.service || "ErrorRsp",
        `userError=${userErrorMessage || "UserError"} callID=${callID}`,
      );
    } else {
      log.pktErr(
        pkt.dest.service || pkt.service || "ErrorRsp",
        `wrapped exception callID=${callID}`,
      );
    }
    session.sendPacket(responseObj);
  }
  /**
   * Recursively scan a result for bound object OID patterns and register them.
   * Handles:
   *  - MachoBindObject result: [substruct(substream([oid, ts])), callResult]
   *  - Direct substruct return: { type: "substruct", value: ... }
   */
  _scanAndRegisterOIDs(result, service, session = null) {
    if (!result || !this.serviceManager) return;
    try {
      if (Array.isArray(result)) {
        for (const elem of result) {
          this._tryRegisterSubstruct(elem, service, session);
        }
      }
      this._tryRegisterSubstruct(result, service, session);
    } catch (e) {
      // ignored: _tryRegisterSubstruct logs its own failures; this only guards walking the result
    }
  }

  _tryRegisterSubstruct(obj, service, session = null) {
    if (!obj || typeof obj !== "object" || obj.type !== "substruct") return;
    try {
      const substream = obj.value;
      const oid =
        substream && substream.type === "substream"
          ? substream.value
          : substream;
      if (
        Array.isArray(oid) &&
        typeof oid[0] === "string" &&
        oid[0].startsWith("N=")
      ) {
        // A service can deliberately delegate a returned reference to its own
        // session-bound child. Do not replace that explicit registration with
        // the factory service while scanning the response for native OIDs.
        const registered = this.serviceManager.lookup(oid[0]);
        const target = registered?.boundObjectOwnerService === service ? registered : service;
        this.serviceManager.registerBoundObject(oid[0], target, oid[1], session);
      }
    } catch (e) {
      log.debug(`[PacketDispatcher] registering a bound object from a call result failed: ${e && e.message}`);
    }
  }
}

module.exports = PacketDispatcher;
