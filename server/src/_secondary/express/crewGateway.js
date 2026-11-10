"use strict";
const path = require("node:path");
const PREFIX = "/_evejs-web/v1/crew";
// The owner IPC transports code/message, not custom HTTP status properties.
const ERROR_STATUS = Object.freeze({
  CREW_COMMAND_INVALID: 400, CREW_OWNER_INVALID: 400, CREW_CARGO_INVALID: 400, CREW_CARGO_CAPACITY: 400, CREW_STATION_INVALID: 400,
  CREW_NOT_FOUND: 404, CREW_DISABLED: 503, CREW_STORE_UNAVAILABLE: 503, CREW_STATE_INVALID: 503, CREW_CAPACITY: 503, CREW_CUSTODY_PENDING: 503,
});

function mountCrewGateway(app, { requireAuthorizedRuntime, validateOwnedCharacter }) {
  const assetRoot = path.resolve(__dirname, "../../../assets/x-command");
  for (const [url, file] of [["/x-command", "index.html"], ["/x-command/", "index.html"],
    ["/x-command/app.js", "app.js"], ["/x-command/style.css", "style.css"]]) {
    app.get(url, (_req, res) => {
      res.set("Cache-Control", "no-store");
      res.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
      res.sendFile(path.join(assetRoot, file));
    });
  }
  const handle = (action) => requireAuthorizedRuntime(async (runtime, req, res) => {
    if (req.method === "POST") {
      if (!req.is("application/json") || (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.get("host")}`) ||
          req.headers["sec-fetch-site"] === "cross-site") {
        res.status(403).json({ ok: false, code: "CREW_ORIGIN_REFUSED", message: "Issue orders from the local X-Command page." }); return;
      }
    }
    const values = req.method === "POST" ? req.body || {} : req.query;
    const owner = await validateOwnedCharacter(runtime, values.accountID, values.characterID);
    if (owner.error) {
      res.status(owner.error[0]).json({ ok: false, code: owner.error[1], message: owner.error[2] }); return;
    }
    try {
      const data = await action(runtime, req, owner.characterID);
      res.json({ ok: true, ...data });
    } catch (error) {
      const known = String(error.code || "").startsWith("CREW_");
      res.status(known ? ERROR_STATUS[error.code] || 409 : 503).json({
        ok: false, code: known ? error.code : "CREW_UNAVAILABLE",
        message: known ? error.message : "Crew operations are temporarily unavailable. Retry the same order.",
      });
    }
  });
  app.get(PREFIX, handle((runtime, _req, id) => runtime.getCrewSnapshot(id)));
  app.get(`${PREFIX}/universe`, handle(async (runtime, _req, id) => ({ universe: await runtime.getCrewUniverse(id) })));
  app.get(`${PREFIX}/stations`, handle(async (runtime, req) => ({ stations: await runtime.searchCrewStations(req.query.q) })));
  app.post(`${PREFIX}/orders`, handle((runtime, req, id) => runtime.submitCrewCommand(id, req.body.command)));
  app.get(`${PREFIX}/mining`, handle((runtime, _req, id) => runtime.getMiningCrewSnapshot(id)));
  app.get(`${PREFIX}/mining/sites`, handle(async (runtime, req, id) => ({ sites: await runtime.getMiningCrewSites(id, Number(req.query.homeStationID)) })));
  app.post(`${PREFIX}/mining/orders`, handle((runtime, req, id) => runtime.submitMiningCrewCommand(id, req.body.command)));
  app.get(`${PREFIX}/refining`, handle((runtime, _req, id) => runtime.getRefiningCrewSnapshot(id)));
  app.get(`${PREFIX}/refining/options`, handle(async (runtime, req, id) => ({ recipes: await runtime.getRefiningCrewOptions(id, Number(req.query.stationID)) })));
  app.post(`${PREFIX}/refining/orders`, handle((runtime, req, id) => runtime.submitRefiningCrewCommand(id, req.body.command)));
  app.get(`${PREFIX}/manufacturing`, handle((runtime, _req, id) => runtime.getManufacturingCrewSnapshot(id)));
  app.get(`${PREFIX}/manufacturing/catalog`, handle(async (runtime, req, id) => ({ blueprints: await runtime.getManufacturingCrewCatalog(id, Number(req.query.stationID)) })));
  app.post(`${PREFIX}/manufacturing/orders`, handle((runtime, req, id) => runtime.submitManufacturingCrewCommand(id, req.body.command)));
  app.get(`${PREFIX}/selling`, handle((runtime, _req, id) => runtime.getSellingCrewSnapshot(id)));
  app.get(`${PREFIX}/selling/catalog`, handle(async (runtime, req, id) => ({ products: await runtime.getSellingCrewCatalog(id, Number(req.query.stationID)) })));
  app.post(`${PREFIX}/selling/orders`, handle((runtime, req, id) => runtime.submitSellingCrewCommand(id, req.body.command)));
  app.get(`${PREFIX}/buying`, handle((runtime, _req, id) => runtime.getBuyingCrewSnapshot(id)));
  app.get(`${PREFIX}/buying/catalog`, handle((runtime, req, id) => runtime.getBuyingCrewCatalog(id, Number(req.query.stationID))));
  app.post(`${PREFIX}/buying/orders`, handle((runtime, req, id) => runtime.submitBuyingCrewCommand(id, req.body.command)));
  app.get(`${PREFIX}/equipment`, handle((runtime, _req, id) => runtime.getCrewEquipmentSnapshot(id)));
  app.post(`${PREFIX}/equipment/orders`, handle((runtime, req, id) => runtime.submitCrewEquipmentCommand(id, req.body.command)));
}
module.exports = { mountCrewGateway };
