"use strict";
const $ = (id) => document.getElementById(id);
const api = "/_evejs-web/v1";
let state = null, scope = 0, busy = false;
let miningState = null, miningSites = null, miningHomes = [];
let refiningState = null, refiningRecipes = null;
let manufacturingState = null, manufacturingCatalog = null, factoryStations = [];
let sellingState = null, sellingCatalog = null, sellingStations = [];
let buyingState = null, buyingCatalog = null;
let equipmentState = null;
let pending = null;
try { pending = JSON.parse(sessionStorage.getItem("xcommand.pending") || "null"); }
catch { sessionStorage.removeItem("xcommand.pending"); }
$("token").value = sessionStorage.getItem("xcommand.token") || "";
function message(text, error = false) { $("message").textContent = text; $("message").classList.toggle("error", error); }
function stationName(station, id) { return station?.stationName || station?.name || `Station ${id}`; }
function crewSkillText(worker, activity, frozen) {
  const skill = worker?.skill;
  if (!skill) return worker ? "Crew experience will appear after the backend is updated." : "";
  const experience = skill.nextLevelXP === null ? `${skill.xp.toLocaleString()} XP · mastered` : `${skill.xp.toLocaleString()} / ${skill.nextLevelXP.toLocaleString()} XP`;
  const benefit = skill.timeReductionPercent ? `${skill.timeReductionPercent}% shorter ${activity}` : `Next level: ${skill.perLevelReductionPercent || 3}% shorter ${activity}`;
  return `${skill.skill} level ${skill.level} / ${skill.maxLevel} · ${experience} · ${benefit}.` +
    (worker.job && (!frozen || frozen.level !== skill.level) ? " Accepted work keeps its saved timing." : "");
}
function tradingSkillText(worker) {
  if (!worker?.skill) return crewSkillText(worker, "trading delays");
  const cooldown = worker.job ? (worker.job.cooldownMs ?? 5000) : worker.timing.cooldownMs;
  return `${crewSkillText(worker, "trading delays", worker.job?.skillAtStart)} Stock checks: ${worker.timing.checkMs / 1000}s · trade cooldown: ${cooldown / 1000}s.`;
}
function equipmentText(gear) { return gear ? ` ${gear.name} tier ${gear.tier}/${gear.maxTier} · ${gear.timeReductionPercent}% shorter time${gear.capacityMultiplier > 1 ? ` · ${Math.round((gear.capacityMultiplier - 1) * 100)}% larger hold` : ""}.` : ""; }
function renderEquipment(data) {
  const current = data?.equipment, previous = equipmentState?.equipment; equipmentState = data;
  const labels = { ready: "Watching for upgrades", stopped: "Reinvestment stopped", installing: "Installing equipment", settlement_pending: "Awaiting settlement", saving_for_upgrade: "Saving profits", payback_too_long: "Waiting for better returns", waiting_for_profitable_demand: "Waiting for profitable demand", waiting_for_useful_work: "Equipment meets current work", waiting_for_factory: "Waiting for production", wallet_reserve: "Protecting working capital" };
  $("equipment-state").textContent = labels[current?.status] || (data ? "Not enabled" : "Unavailable");
  if (current && current.ownerID !== previous?.ownerID) for (const [id, key] of [["equipment-budget", "budgetISK"], ["equipment-reserve", "walletReserve"], ["equipment-capital", "workingCapitalISK"], ["equipment-share", "reinvestPercent"], ["equipment-payback", "maxPaybackHours"]]) $(id).value = String(current.plan[key]);
  $("equipment-funding").textContent = current ? `${current.totalSpent.toLocaleString()} ISK invested · ${current.funding.operatingProfit.toLocaleString()} ISK realized operating profit · ${current.funding.profitAllowance.toLocaleString()} ISK profit allowance left.` : "Uses realized sales after mineral purchases, refining tax and factory fees.";
  $("equipment-upgrades").replaceChildren();
  for (const upgrade of current?.upgrades || []) { const li = document.createElement("li"); li.textContent = equipmentText(upgrade).trim() + (upgrade.nextCost ? ` Next tier: ${upgrade.nextCost.toLocaleString()} ISK.` : " Fully upgraded."); $("equipment-upgrades").append(li); }
  const decision = current?.assessment;
  $("equipment-decision").textContent = decision ? `Protected working capital: ${decision.workingCapitalISK.toLocaleString()} ISK beyond wallet reserve. ` + decision.candidates.map(row => `${row.role} tier ${row.tier}: ${row.cost.toLocaleString()} ISK, estimated payback ${row.paybackHours.toFixed(1)}h`).join(" · ") : "New purchases wait for demonstrated work and a profitable production opportunity.";
  $("equipment-history").replaceChildren();
  for (const purchase of current?.history || []) { const article = document.createElement("article"); article.textContent = `${purchase.role} tier ${purchase.tier} installed · ${purchase.cost.toLocaleString()} ISK · ${new Date(purchase.installedAtMs).toLocaleString()}`; $("equipment-history").append(article); }
  lock();
}
function option(select, value, text) { const item = document.createElement("option"); item.value = String(value); item.textContent = text; select.append(item); }
function identity() { return { accountID: Number($("account").value), characterID: Number($("character").value) }; }
function renderRoster() {
  $("roster").replaceChildren();
  const people = [...(state?.crew?.roster || []), ...(miningState?.mining?.roster || []), ...(refiningState?.refining?.roster || []), ...(manufacturingState?.manufacturing?.roster || []), ...(sellingState?.selling?.roster || []), ...(buyingState?.buying?.roster || [])];
  if (!people.length) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "Establish a crew to meet your team."; $("roster").append(li); }
  for (const person of people) { const li = document.createElement("li"), role = document.createElement("span"); li.textContent = person.name; role.textContent = person.role; li.append(role); $("roster").append(li); }
}
async function request(url, body) {
  const headers = {}; const token = $("token").value.trim();
  if (token) headers["x-evejs-web-token"] = token;
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(api + url, { headers, method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok || data.ok === false) { const error = new Error(data.message || data.error?.message || "The request could not be completed."); error.status = response.status; throw error; }
  return data;
}
function lock() {
  for (const id of ["start-equipment", "equipment-budget", "equipment-reserve", "equipment-capital", "equipment-share", "equipment-payback"]) $(id).disabled = busy || Boolean(pending) || !equipmentState?.enabled;
  $("stop-equipment").hidden = !equipmentState?.equipment?.plan.enabled; $("stop-equipment").disabled = busy || Boolean(pending);
  const job = state?.crew?.job;
  const automatic = state?.crew?.standingOrder?.enabled;
  $("account").disabled = busy || Boolean(pending) || !$("account").options.length;
  $("character").disabled = busy || Boolean(pending) || !Number($("character").value);
  for (const id of ["station-search", "destination", "cargo", "dispatch", "source-reserve", "supply-type"]) $(id).disabled = busy || Boolean(pending) || Boolean(job) || automatic;
  $("automate").disabled = busy || Boolean(pending) || Boolean(job) || automatic || !$("supply-type").value;
  $("stop-automation").hidden = !automatic;
  $("stop-automation").disabled = busy || Boolean(pending);
  $("follow-courier").hidden = !automatic || !state?.planningEnabled;
  $("follow-courier").disabled = busy || Boolean(pending);
  $("pause").disabled = busy || Boolean(pending) || (!automatic && job?.phase !== "travelling");
  $("retry").hidden = !pending; $("retry").disabled = busy;
  $("create-form").querySelector("button").disabled = busy || Boolean(pending);
  const miners = miningState?.mining, miningActive = miners?.plan.enabled || miners?.job;
  for (const id of ["mining-home", "mining-home-search", "find-mining-home", "load-belts", "mining-belt", "mining-ore", "start-mining"]) $(id).disabled = busy || Boolean(pending) || Boolean(miningActive) || !miningState?.enabled;
  $("start-mining").disabled ||= !$("mining-ore").value || !miningSites;
  $("pause-mining").hidden = !miners?.plan.enabled;
  $("stop-mining").hidden = !miners?.plan.enabled;
  $("pause-mining").disabled = $("stop-mining").disabled = busy || Boolean(pending);
  $("follow-mining").hidden=!miners?.plan.enabled||!miningState?.planningEnabled;$("follow-mining").disabled=busy||Boolean(pending);
  const refinery = refiningState?.refining, refiningActive = refinery?.plan.enabled || refinery?.job;
  for (const id of ["refining-station", "load-refining", "refining-ore", "refining-reserve", "start-refining"]) $(id).disabled = busy || Boolean(pending) || Boolean(refiningActive) || !refiningState?.enabled;
  $("start-refining").disabled ||= !refiningRecipes || !$("refining-ore").value;
  $("pause-refining").hidden = $("stop-refining").hidden = !refinery?.plan.enabled;
  $("pause-refining").disabled = $("stop-refining").disabled = busy || Boolean(pending);
  $("follow-refining").hidden=!refinery?.plan.enabled||!refiningState?.planningEnabled;$("follow-refining").disabled=busy||Boolean(pending);
  const factory = manufacturingState?.manufacturing, factoryActive = factory?.plan?.enabled || factory?.job;
  for (const id of ["factory-search", "find-factory", "manufacturing-station", "load-blueprints", "starter-blueprints", "start-manufacturing"]) $(id).disabled = busy || Boolean(pending) || Boolean(factoryActive) || !manufacturingState?.enabled;
  for (const input of $("blueprint-options").querySelectorAll("input")) input.disabled = busy || Boolean(pending) || Boolean(factoryActive);
  $("start-manufacturing").disabled ||= !manufacturingCatalog?.blueprints.length;
  $("pause-manufacturing").hidden = $("stop-manufacturing").hidden = !factory?.plan?.enabled;
  $("pause-manufacturing").disabled = $("stop-manufacturing").disabled = busy || Boolean(pending);
  const selling = sellingState?.selling, sellingActive = selling?.plan.enabled || selling?.job;
  for (const id of ["selling-search", "find-selling", "selling-station", "load-selling", "start-selling"]) $(id).disabled = busy || Boolean(pending) || Boolean(sellingActive) || !sellingState?.enabled;
  for (const input of $("selling-options").querySelectorAll("input")) input.disabled = busy || Boolean(pending) || Boolean(sellingActive);
  $("start-selling").disabled ||= !sellingCatalog?.products.length;
  $("pause-selling").hidden = $("stop-selling").hidden = !selling?.plan.enabled;
  $("pause-selling").disabled = $("stop-selling").disabled = busy || Boolean(pending);
  const buying = buyingState?.buying, buyingActive = buying?.plan.enabled || buying?.job;
  for (const id of ["buying-station", "load-buying", "buying-budget", "buying-reserve", "start-buying"]) $(id).disabled = busy || Boolean(pending) || Boolean(buyingActive) || !buyingState?.enabled;
  for (const input of $("buying-options").querySelectorAll("input")) input.disabled = busy || Boolean(pending) || Boolean(buyingActive);
  $("start-buying").disabled ||= !buyingCatalog?.minerals.length;
  $("pause-buying").hidden = $("stop-buying").hidden = !buying?.plan.enabled;
  $("pause-buying").disabled = $("stop-buying").disabled = busy || Boolean(pending);
}
function supplyTypes() {
  const standing = state?.crew?.standingOrder;
  const selected = standing?.enabled ? standing.typeIDs?.length > 1 ? "route" : String(standing.typeID) : $("supply-type").value || String(standing?.typeID || "");
  const types = new Map((state?.cargo || []).map(item => [item.typeID, item.name]));
  const miners = miningState?.mining;
  if (miners) types.set(miners.plan.typeID, miners.plan.oreName || `Ore ${miners.plan.typeID}`);
  const refinery = refiningState?.refining;
  for (const output of refinery?.plan.recipe.outputs || []) types.set(output.typeID, output.name);
  if (standing?.enabled && !types.has(standing.typeID)) types.set(standing.typeID, `Type ${standing.typeID}`);
  $("supply-type").replaceChildren(); option($("supply-type"), "", "Choose material");
  for (const [id, name] of types) option($("supply-type"), id, name);
  if (refinery?.plan.recipe.outputs.length > 1) option($("supply-type"), "refinery", `All refinery minerals: ${refinery.plan.recipe.outputs.map(o => o.name).join(" + ")}`);
  if (standing?.typeIDs?.length > 1) option($("supply-type"), "route", `Route minerals: ${standing.typeIDs.map(id => types.get(id) || `Type ${id}`).join(" + ")}`);
  if ([...$("supply-type").options].some(o => o.value === selected)) $("supply-type").value = selected;
  else if (miners) $("supply-type").value = String(miners.plan.typeID);
  const mineral = $("supply-type").value === "refinery" || refinery?.plan.recipe.outputs.some(output => output.typeID === Number($("supply-type").value));
  const home = standing?.enabled || $("supply-type").value === "route" ? standing.sourceStation : mineral ? refinery.station : miners && Number($("supply-type").value) === miners.plan.typeID ? miners.homeStation : state?.crew?.station;
  $("supply-source").textContent = `Supply source: ${stationName(home, home?.stationID || state?.crew?.stationID)}. The route waits for stock here.`;
}
function renderOres() {
  const belt = miningSites?.sites.find(site => site.beltID === Number($("mining-belt").value));
  $("mining-ore").replaceChildren(); option($("mining-ore"), "", "Choose ore");
  for (const ore of belt?.ores || []) if (ore.remainingQuantity > 0) option($("mining-ore"), ore.typeID, `${ore.name} · ${ore.remainingQuantity.toLocaleString()} units remaining`);
  if ($("mining-ore").options.length === 2) $("mining-ore").selectedIndex = 1;
  lock();
}
function renderRecipe() {
  const recipe = refiningState?.refining?.plan.followProduction?refiningState.refining.plan.recipe:refiningRecipes?.recipes.find(recipe => recipe.typeID === Number($("refining-ore").value)) || refiningState?.refining?.plan.recipe;
  $("refining-recipe").textContent = recipe ? `${recipe.portionSize} ${recipe.name} → ${recipe.outputs.map(o => `${o.quantity.toLocaleString()} ${o.name}`).join(" + ")}. ${(recipe.efficiency * 100).toFixed(1)}% yield; ${recipe.totalCost.toLocaleString()} ISK tax per portion.` : "Load ore recipes to see mineral yield and station tax.";
  lock();
}
const resourceLabels={waiting_for_production_plan:"Checking production needs",waiting_for_refinery:"Waiting for an active refinery",waiting_for_factory:"Waiting for production",waiting_for_supply_route:"Waiting for mineral supply route",waiting_for_useful_ore:"No useful ore available locally",resource_plan_unavailable:"Resource planning unavailable",stock_target_met:"Production mineral buffers stocked",ore_not_economical:"Refining costs more than the missing minerals",waiting_for_local_supply:"Waiting for local mineral supply"};
function resourcePriorityText(worker,kind){
  if(!worker?.plan.followProduction)return "Fixed ore assignment. Follow production to choose ore for profitable recipes.";
  if(worker.job&&!worker.job.priority)return `Following production after the accepted ${kind} finishes.`;
  const p=worker.priority;if(!worker.job)return `Following production · ${resourceLabels[worker.status]||profitLabels[worker.status]||"checking mineral needs"}.`;
  const missing=(p?.deficits||[]).filter(m=>m.missing&&m.transportable).map(m=>`${m.missing.toLocaleString()} ${m.name}`).join(" + ");
  return p?.oreName?`${p.oreName} for ${p.name}${missing?` · planned shortage: ${missing}`:""}. Next choices update as demand changes.`:"Following production needs.";
}
function renderRefining(data) {
  refiningState = data; const refinery = data?.refining, job = refinery?.job;
  $("refining-skill").textContent = crewSkillText(refinery, "refining cycles", job?.skillAtStart);
  const labels = { reserving: "Reserving ore", working: "Refining ore", refining: "Refining ore", settling: "Confirming minerals", returning: "Returning partial ore", acknowledging: "Confirming batch", waiting_for_ore: "Waiting for ore", insufficient_funds: "Needs ISK for tax", input_rejected: "Input rejected", ready: "Preparing next batch", stopped: "At station" };
  $("refining-state").textContent = refinery?.paused ? "Paused" : labels[job?.phase || refinery?.status] || resourceLabels[refinery?.status] || profitLabels[refinery?.status] || "Stand by";
  $("refining-summary").textContent = !data ? "Refining operations are unavailable. Check the backend connection." : !data.enabled ? "Crew refining is disabled." : refinery ? `${refinery.roster.map(p => p.name).join(" & ")} · ${stationName(refinery.station, refinery.plan.stationID)}` : "Turn delivered ore into minerals for your supply route and manufacturing.";
  const selected = $("refining-station").value; $("refining-station").replaceChildren(); const stations = new Map();
  for (const station of [refinery?.station, miningState?.mining?.homeStation, state?.crew?.standingOrder?.sourceStation, state?.crew?.station]) if (station) stations.set(station.stationID, station);
  for (const [id, station] of stations) option($("refining-station"), id, stationName(station, id));
  if (stations.has(Number(selected))) $("refining-station").value = selected;
  if (refinery && (!refiningRecipes||refinery.plan.followProduction)) { $("refining-ore").replaceChildren(); option($("refining-ore"), refinery.plan.typeID, refinery.plan.recipe.name); $("refining-reserve").value = refinery.plan.oreReserve; }
  $("refining-load").textContent = job ? `${job.cargo.quantity.toLocaleString()} ${job.quote.name} reserved · ${job.quote.quantityToProcess.toLocaleString()} units in this batch.` : refinery ? labels[refinery.status] || resourceLabels[refinery.status] || profitLabels[refinery.status] || "Following production needs" : "Waiting for a refining assignment";
  $("refining-processed").textContent = (refinery?.totalOreProcessed || 0).toLocaleString();
  $("refining-batches").textContent = (refinery?.completedBatches || 0).toLocaleString();
  $("refining-tax").textContent = (refinery?.totalTaxPaid || 0).toLocaleString();
  $("refining-minerals").textContent = refinery?.completedBatches ? Object.entries(refinery.mineralsProduced).map(([typeID, quantity]) => `${quantity.toLocaleString()} ${refinery.plan.recipe.outputs.find(o => o.typeID === Number(typeID))?.name || manufacturingState?.manufacturing?.plan?.orders.flatMap(o=>o.recipe.materials).find(m=>m.typeID===Number(typeID))?.name || `Type ${typeID}`}`).join(" · ") : "No minerals produced yet.";
  $("pause-refining").textContent = refinery?.paused ? "Resume refinery" : "Pause refinery";
  $("follow-refining").textContent=refinery?.plan.followProduction?"Keep current ore":"Follow production";$("refining-priority").textContent=resourcePriorityText(refinery,"batch");
  $("refining-routing").textContent = refinery && state?.crew?.standingOrder?.enabled && state.crew.standingOrder.typeID === refinery.plan.typeID ?
    "Your courier currently ships raw ore. Stop that route, finish its trip, then select a mineral and restart the supply route. Minerals accumulate here meanwhile." :
    "Minerals reach this station's hangar, where manufacturing and supply routes can use them. Partial ore portions remain available for a later batch.";
  if (job?.recoveryError) message(job.recoveryError, true);
  renderRoster(); supplyTypes(); renderRecipe(); lock();
}
function renderMining(data) {
  miningState = data; const miners = data?.mining, job = miners?.job;
  $("mining-skill").textContent = crewSkillText(miners, "extraction cycles", job?.skillAtStart) + equipmentText(miners?.equipment);
  const labels = { outbound: "Travelling to belt", working: "Extracting ore", extracting: "Confirming extraction", returning: "Returning home",
    unloading: "Unloading ore", acknowledging: "Confirming delivery", confirming_delivery: "Confirming delivery", depleted: "Ore depleted", ready: "Ready for next load", stopped: "At home", finishing_current_trip: "Returning and stopping" };
  $("mining-state").textContent = miners?.paused ? "Paused" : labels[job?.phase || miners?.status] || resourceLabels[miners?.status]||profitLabels[miners?.status]||"Stand by";
  $("mining-summary").textContent = !data ? "Mining operations are unavailable. Check the backend connection." : !data.enabled ? "Mining crews are disabled in this server's configuration." : miners ?
    `${miners.roster.map(person => person.name).join(" & ")} · ${miners.belt.itemName || miners.belt.name} → ${stationName(miners.homeStation, miners.plan.homeStationID)}` :
    "Assign a foreman and ore tender to supply your home station.";
  const selectedHome = $("mining-home").value;
  $("mining-home").replaceChildren(); const homes = new Map();
  for (const station of [miners?.homeStation, state?.crew?.standingOrder?.sourceStation, state?.crew?.station, ...miningHomes]) if (station) homes.set(station.stationID, station);
  for (const [id, station] of homes) option($("mining-home"), id, stationName(station, id));
  if (homes.has(Number(selectedHome))) $("mining-home").value = selectedHome;
  if (miners && (!miningSites||miners.plan.followProduction)) {
    $("mining-belt").replaceChildren(); option($("mining-belt"), miners.plan.beltID, miners.belt.itemName || miners.belt.name);
    $("mining-ore").replaceChildren(); option($("mining-ore"), miners.plan.typeID, miners.plan.oreName || `Ore ${miners.plan.typeID}`);
  }
  $("pause-mining").textContent = miners?.paused ? "Resume miners" : "Pause miners";
  $("follow-mining").textContent=miners?.plan.followProduction?"Keep current ore":"Follow production";$("mining-priority").textContent=resourcePriorityText(miners,"trip");
  $("mining-load").textContent = job?.cargo ? job.phase === "acknowledging" ? `${job.cargo.quantity.toLocaleString()} × ${job.cargo.name} delivered home; confirming receipt.` : `${job.cargo.quantity.toLocaleString()} × ${job.cargo.name} / ${job.cargo.volumeM3.toLocaleString()} m³ in miner custody` : "Mining hold empty";
  for (const [id, value] of [["mining-extracted", miners?.totalMined], ["mining-delivered", miners?.totalDelivered], ["mining-trips", miners?.completedDeliveries]]) $(id).textContent = (value || 0).toLocaleString();
  const extractionMs = job?.cycleMs ?? (data?.settings ? Math.ceil(data.settings.cycleMs * (miners?.skill?.durationBasisPoints || 10000) / 10000) : 0);
  $("mining-settings").textContent = data?.settings ? `${data.settings.batchM3} m³ per load · ${extractionMs / 1000}s extraction · ${data.settings.travelMs / 1000}s travel each way.` : "";
  renderRoster();
  if (job?.recoveryError) message(job.recoveryError, true);
  supplyTypes(); lock();
}
const profitLabels = {unprofitable:"Waiting for profitable prices",waiting_for_sales_policy:"Needs active selling orders",selling_reserve_blocks_production:"Selling reserve blocks surplus",waiting_for_profitable_demand:"Waiting for enough sale demand",waiting_for_market_prices:"Waiting for mineral prices",market_unavailable:"Market unavailable",production_targets_covered:"Production targets covered"};
function profitText(quotes){
  const money=n=>n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  return [...new Set(quotes.filter(Boolean).map(p=>{
    const name=p.name||manufacturingState?.manufacturing?.plan?.orders.find(o=>o.recipe.productTypeID===p.productTypeID)?.recipe.name||"Recipe";
    return Number.isFinite(p.expectedProfit)?`${name}: ${money(p.netRevenue)} net sales − ${money(p.materialCost)} replacement minerals − ${money(p.factoryFee)} factory fees = ${money(p.expectedProfit)} ISK per batch${p.allowed?"":" · waiting"}.`:`${name}: ${p.reason||profitLabels[p.status]||"Waiting for a profit quote"}`;
  }))].join(" ");
}
const manufacturingLabels = { ...profitLabels, installing: "Installing native job", building: "Manufacturing", delivering: "Delivering finished goods", acknowledging: "Confirming delivery", ready: "Preparing next job", stopped: "At factory", paused: "New jobs paused", stock_target_met: "Stock targets met", waiting_for_materials: "Waiting for minerals", factory_busy: "Factory slot busy", insufficient_funds: "Needs ISK for fees", needs_skill: "Needs Industry skills", blueprint_unavailable: "Blueprint unavailable", installation_rejected: "Installation rejected", job_cancelled: "Native job cancelled" };
function renderBlueprints(blueprints, selectedOrders = []) {
  $("blueprint-options").replaceChildren();
  if (!blueprints.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "No supported ammo or module blueprints here. Add the starter pack, or move your own blueprints to this factory."; $("blueprint-options").append(p); }
  for (const b of blueprints) {
    const selected = selectedOrders.find(o => o.blueprintID === b.blueprintID), row = document.createElement("div"); row.className = "blueprint-choice"; row.dataset.blueprintId = String(b.blueprintID);
    const title = document.createElement("label"), check = document.createElement("input"); check.type = "checkbox"; check.checked = Boolean(selected); check.className = "blueprint-selected";
    title.append(check, document.createTextNode(b.name)); row.append(title);
    const detail = document.createElement("p"); detail.className = "capacity";
    detail.textContent = `${b.category} · ${b.original ? "Original blueprint" : `${b.runsRemaining} licensed runs`} · ${b.quantity.toLocaleString()} per batch · ${b.materials.map(m => `${m.quantity.toLocaleString()} ${m.name}`).join(" + ")}${b.timeSeconds ? ` · ${Math.ceil(b.timeSeconds)}s per run` : ""}${b.cost != null ? ` · ${b.cost.toLocaleString()} ISK` : ""}${b.status && b.status !== "ready" ? ` · ${manufacturingLabels[b.status] || b.status}` : ""}.`;
    row.append(detail);
    const fields = document.createElement("div"); fields.className = "batch-fields";
    for (const [kind, label, value, max] of [["runs", "Runs per batch", selected?.runs || 1, 1000], ["target", "Target stock (units)", selected?.targetStock || b.quantity, 1000000]]) {
      const fieldLabel = document.createElement("label"), input = document.createElement("input"); input.type = "number"; input.min = "1"; input.max = String(max); input.step = "1"; input.value = String(value); input.className = `blueprint-${kind}`;
      fieldLabel.append(document.createTextNode(`${b.name}: ${label}`), input); fields.append(fieldLabel);
    }
    row.append(fields); $("blueprint-options").append(row);
  }
  lock();
}
function renderManufacturing(data) {
  manufacturingState = data; const factory = data?.manufacturing, job = factory?.job;
  $("manufacturing-skill").textContent = crewSkillText(factory, "native factory jobs", job?.summary.crewSkill) + equipmentText(factory?.equipment);
  $("manufacturing-state").textContent = factory?.paused && !job ? "New jobs paused" : manufacturingLabels[job?.phase || factory?.status] || "Stand by";
  $("manufacturing-summary").textContent = !data ? "Manufacturing is unavailable. Check the backend connection." : !data.enabled ? "Crew manufacturing is disabled." : factory ? `${factory.roster.map(p => p.name).join(" & ")} · ${stationName(factory.station, factory.stationID)}` : "Keep ammo and modules stocked using your blueprints and delivered minerals.";
  const selected = $("manufacturing-station").value, stations = new Map();
  for (const station of [factory?.station, state?.crew?.standingOrder?.destinationStation, state?.crew?.station, refiningState?.refining?.station, ...factoryStations]) if (station) stations.set(station.stationID, station);
  $("manufacturing-station").replaceChildren(); for (const [id, station] of stations) option($("manufacturing-station"), id, stationName(station, id));
  if (stations.has(Number(selected))) $("manufacturing-station").value = selected;
  $("starter-blueprints").hidden = Boolean(factory?.starter?.complete);
  $("starter-note").textContent = factory?.starter?.complete ? `Starter blueprints assigned once to ${stationName(stations.get(factory.starter.stationID), factory.starter.stationID)}.` : "One starter pack per pilot: Iron Charge S and 1MN Civilian Afterburner original blueprints.";
  if (!manufacturingCatalog && factory?.plan?.stationID === Number($("manufacturing-station").value) && !$("blueprint-options").querySelector("input")) renderBlueprints(factory.plan.orders.map(o => o.recipe), factory.plan.orders);
  $("manufacturing-job").textContent = job ? `${job.summary.quantity.toLocaleString()} × ${job.summary.name}` : manufacturingLabels[factory?.status] || "Waiting for a production queue";
  let eta = "";
  if (job?.endDate) { try { const finish = Number(BigInt(job.endDate) / 10000n) - 11644473600000; eta = `Ready ${new Date(finish).toLocaleString()} · ${Math.max(0, Math.ceil((finish - Date.now()) / 1000))}s remaining.`; } catch { /* native time unavailable */ } }
  $("manufacturing-eta").textContent = eta;
  $("manufacturing-batches").textContent = (factory?.completedBatches || 0).toLocaleString(); $("manufacturing-fees").textContent = (factory?.totalFeesPaid || 0).toLocaleString();
  const recipes = factory?.plan?.orders.map(o => o.recipe) || [];
  $("manufacturing-produced").textContent = factory?.completedBatches ? Object.entries(factory.produced).map(([type, qty]) => `${qty.toLocaleString()} ${recipes.find(r => r.productTypeID === Number(type))?.name || `Type ${type}`}`).join(" · ") : "No finished goods yet.";
  $("manufacturing-availability").textContent = (factory?.availability || []).filter(a=>a.status!=="ready").map(a => `${recipes.find(r => r.blueprintID === a.blueprintID)?.name || "Blueprint"}: ${manufacturingLabels[a.status] || a.status} (${a.stock.toLocaleString()} in hangar)`).join(". ");
  $("manufacturing-profit").textContent = profitText([job?.summary.profit,...(factory?.availability||[]).map(a=>a.profit)]) || "New jobs require net sales above mineral replacement costs and factory fees. Accepted jobs finish if prices change.";
  const selection=factory?.selection;
  $("manufacturing-strategy").textContent=selection?"Latest ranking: net ISK per production hour":"Priority: net ISK per production hour · applies to the next new batch";
  $("manufacturing-ranking").replaceChildren();
  for(const candidate of selection?.candidates||[]){
    const row=document.createElement("li"),selected=Boolean(job&&selection.selectedBlueprintID===candidate.blueprintID&&job.summary.blueprintID===candidate.blueprintID);
    const estimate=Number.isFinite(candidate.profitPerHour)?`${candidate.profitPerHour.toLocaleString(undefined,{maximumFractionDigits:2})} ISK/hour · ${candidate.expectedProfit.toLocaleString(undefined,{maximumFractionDigits:2})} ISK/batch · ${candidate.timeSeconds}s`:"No profitable rate available";
    row.textContent=`${candidate.name}: ${estimate} · ${selected?"selected for this batch":candidate.ready?"eligible":manufacturingLabels[candidate.status]||candidate.status}`;
    $("manufacturing-ranking").append(row);
  }
  $("pause-manufacturing").textContent = factory?.paused ? "Resume queue" : "Pause new jobs";
  $("manufacturing-history").replaceChildren();
  for (const batch of (factory?.history || []).slice(0, 5)) { const article = document.createElement("article"), p = document.createElement("p"); article.textContent = `${batch.quantity.toLocaleString()} × ${batch.name} ${batch.outcome}`; p.textContent = `${new Date(batch.completedAtMs).toLocaleString()} · ${batch.cost.toLocaleString()} ISK`; article.append(p); $("manufacturing-history").append(article); }
  if (job?.recoveryError) message(job.recoveryError, true);
  renderRoster(); lock();
}
const sellingLabels = { selling: "Selling surplus", acknowledging: "Confirming proceeds", reserve_met: "Stock reserve held", waiting_for_buyers: "Waiting for buyers", ready: "Checking surplus", paused: "New sales paused", stopped: "At market", market_unavailable: "Market unavailable" };
function renderSellingProducts(products, orders = []) {
  $("selling-options").replaceChildren();
  if (!products.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "No supported products here yet. Assign ammo/module blueprints to a manufacturing crew first."; $("selling-options").append(p); }
  for (const product of products) {
    const selected = orders.find(o => o.typeID === product.typeID), row = document.createElement("div"); row.className = "blueprint-choice"; row.dataset.typeId = String(product.typeID);
    const title = document.createElement("label"), check = document.createElement("input"); check.type = "checkbox"; check.className = "selling-selected"; check.checked = Boolean(selected); title.append(check, document.createTextNode(product.name)); row.append(title);
    const p = document.createElement("p"); p.className = "capacity"; p.textContent = product.bestPrice ? `At load: ${product.stock.toLocaleString()} in hangar · best local NPC bid ${product.bestPrice.toLocaleString()} ISK · ${product.demand.toLocaleString()} units of demand.` : product.stock != null ? `At load: ${product.stock.toLocaleString()} in hangar · no local NPC buyers.` : "Saved surplus policy"; row.append(p);
    const fields = document.createElement("div"); fields.className = "batch-fields";
    for (const [key, label, value, min, max, step] of [["reserve", "Keep in stock", selected?.reserve ?? (product.category === "Ammo" ? 100 : 1), 0, 1000000000, 1], ["batch", "Max units per sale", selected?.batchSize || (product.category === "Ammo" ? 100 : 1), 1, 10000, 1], ["price", "Minimum ISK per unit", selected?.minimumPrice || Math.max(0.01, Math.round((product.bestPrice || 1) * 90) / 100), 0.01, 100000000, 0.01]]) {
      const labelNode = document.createElement("label"), input = document.createElement("input"); input.type = "number"; input.value = String(value); input.min = String(min); input.max = String(max); input.step = String(step); input.className = `selling-${key}`; labelNode.append(document.createTextNode(`${product.name}: ${label}`), input); fields.append(labelNode);
    }
    row.append(fields); $("selling-options").append(row);
  }
  lock();
}
function renderSelling(data) {
  sellingState = data; const sellers = data?.selling, job = sellers?.job;
  $("selling-skill").textContent = tradingSkillText(sellers);
  $("selling-state").textContent = sellers?.paused && !job ? "New sales paused" : sellingLabels[job?.phase || sellers?.status] || "Stand by";
  $("selling-summary").textContent = !data ? "Selling operations are unavailable. Check the backend connection." : !data.enabled ? "Crew selling is disabled." : sellers ? `${sellers.roster.map(p => p.name).join(" & ")} · ${stationName(sellers.station, sellers.stationID)}` : "Sell surplus ammo and modules to local NPC buyers. Net proceeds fund your shared pilot wallet.";
  const selected = $("selling-station").value, stations = new Map();
  for (const station of [sellers?.station, manufacturingState?.manufacturing?.station, state?.crew?.standingOrder?.destinationStation, state?.crew?.station, ...sellingStations]) if (station) stations.set(station.stationID, station);
  $("selling-station").replaceChildren(); for (const [id, station] of stations) option($("selling-station"), id, stationName(station, id)); if (stations.has(Number(selected))) $("selling-station").value = selected;
  const describe = typeID => manufacturingState?.manufacturing?.plan?.orders.find(o => o.recipe.productTypeID === typeID)?.recipe.name || sellingCatalog?.products.find(p => p.typeID === typeID)?.name || `Type ${typeID}`;
  if (!sellingCatalog && sellers?.stationID === Number($("selling-station").value) && !$("selling-options").querySelector("input")) renderSellingProducts(sellers.plan.orders.map(o => ({typeID:o.typeID,name:describe(o.typeID)})), sellers.plan.orders);
  $("selling-job").textContent = job ? `${job.summary.quantity.toLocaleString()} × ${job.summary.name} · ${job.summary.net.toLocaleString()} ISK after tax` : sellingLabels[sellers?.status] || "Waiting for a selling policy";
  $("selling-count").textContent = (sellers?.completedSales || 0).toLocaleString(); $("selling-net").textContent = (sellers?.netRevenue || 0).toLocaleString();
  $("selling-accounting").textContent = `Gross ${(sellers?.grossRevenue || 0).toLocaleString()} ISK · sales tax ${(sellers?.taxPaid || 0).toLocaleString()} ISK`;
  $("selling-availability").textContent = (sellers?.availability || []).map(a => `${describe(a.typeID)}: ${sellingLabels[a.status] || a.status} (${a.stock.toLocaleString()} in hangar)`).join(". ");
  const production = manufacturingState?.manufacturing;
  $("selling-production").textContent = sellers && production?.stationID === sellers.stationID ? sellers.plan.orders.map(o => {
    const plan = production.plan?.orders.find(p => p.recipe.productTypeID === o.typeID); return `${describe(o.typeID)}: factory target ${plan?.targetStock ?? "unassigned"}, selling reserve ${o.reserve.toLocaleString()}${plan && plan.targetStock <= o.reserve ? " — raise the production target to create surplus" : ""}.`;
  }).join(" ") : "Set production targets higher than selling reserves so your factory can produce a surplus.";
  $("pause-selling").textContent = sellers?.paused ? "Resume sales" : "Pause new sales";
  $("selling-history").replaceChildren(); for (const sale of (sellers?.history || []).slice(0,5)) { const article = document.createElement("article"), p = document.createElement("p"); article.textContent = sale.rejected ? `${sale.name}: offer changed, goods retained` : `${sale.quantity.toLocaleString()} × ${sale.name} sold · ${sale.net.toLocaleString()} ISK net`; p.textContent = `${new Date(sale.completedAtMs).toLocaleString()} · ${sale.unitPrice.toLocaleString()} ISK per unit`; article.append(p); $("selling-history").append(article); }
  if (job?.recoveryError) message(job.recoveryError, true); renderRoster(); lock();
}
const buyingLabels = {...profitLabels,...resourceLabels,buying:"Buying minerals",acknowledging:"Confirming delivery",ready:"Checking mineral stock",stock_target_met:"Mineral buffers stocked",waiting_for_factory:"Waiting for factory demand",waiting_for_income:"Waiting for sales income",budget_exhausted:"Spending cap reached",wallet_reserve:"Wallet reserve protected",waiting_for_sellers:"Waiting for sellers",budget_too_small:"Not enough buying allowance",not_required:"Recipe no longer needs this mineral",market_unavailable:"Market unavailable",paused:"New purchases paused",stopped:"At factory"};
function renderBuyingMinerals(minerals, orders = []) {
  $("buying-options").replaceChildren();
  if(!minerals.length){const p=document.createElement("p");p.className="muted";p.textContent="Assign an active manufacturing queue at this station to load its required minerals.";$("buying-options").append(p);}
  for(const mineral of minerals){
    const selected=orders.find(o=>o.typeID===mineral.typeID),row=document.createElement("div");row.className="blueprint-choice";row.dataset.typeId=String(mineral.typeID);
    const label=document.createElement("label"),check=document.createElement("input");check.type="checkbox";check.className="buying-selected";check.checked=Boolean(selected);label.append(check,document.createTextNode(mineral.name));row.append(label);
    const p=document.createElement("p");p.className="capacity";p.textContent=mineral.stock!=null?`At load: ${mineral.stock.toLocaleString()} in hangar · ${mineral.batchRequirement.toLocaleString()} per set of queued batches · ${mineral.bestPrice ? `${mineral.bestPrice.toLocaleString()} ISK best local NPC ask` : "no local NPC sellers"}.`:"Saved restocking policy";row.append(p);
    const fields=document.createElement("div");fields.className="batch-fields";
    const buffer=Math.min(100000,Math.max(1,(mineral.batchRequirement||1)*5));
    for(const[key,text,value,max,step]of [["target","Target mineral stock",selected?.targetStock||buffer,1000000,1],["batch","Max units per purchase",selected?.batchSize||buffer,100000,1],["price","Maximum ISK per unit",selected?.maximumPrice||Math.max(0.01,Math.ceil((mineral.bestPrice||1)*110)/100),100000000,0.01]]){
      const field=document.createElement("label"),input=document.createElement("input");input.type="number";input.value=String(value);input.min=String(step);input.max=String(max);input.step=String(step);input.className=`buying-${key}`;field.append(document.createTextNode(`${mineral.name}: ${text}`),input);fields.append(field);
    }
    row.append(fields);$("buying-options").append(row);
  }
  lock();
}
function renderBuying(data){
  buyingState=data;const buyers=data?.buying,job=buyers?.job;
  $("buying-skill").textContent=tradingSkillText(buyers);
  $("buying-state").textContent=buyers?.paused&&!job?"New purchases paused":buyingLabels[job?.phase||buyers?.status]||"Stand by";
  $("buying-summary").textContent=!data?"Buying operations are unavailable. Check the backend connection.":!data.enabled?"Crew buying is disabled.":buyers?`${buyers.roster.map(p=>p.name).join(" & ")} · ${stationName(buyers.station,buyers.stationID)}`:"Restock production minerals using income earned by your selling crew.";
  const selected=$("buying-station").value,stations=new Map();for(const station of [buyers?.station,manufacturingState?.manufacturing?.station])if(station)stations.set(station.stationID,station);
  $("buying-station").replaceChildren();for(const[id,station]of stations)option($("buying-station"),id,stationName(station,id));if(stations.has(Number(selected)))$("buying-station").value=selected;
  const name=typeID=>buyingCatalog?.minerals.find(m=>m.typeID===typeID)?.name||manufacturingState?.manufacturing?.plan?.orders.flatMap(o=>o.recipe.materials).find(m=>m.typeID===typeID)?.name||`Type ${typeID}`;
  if(!buyingCatalog&&buyers?.stationID===Number($("buying-station").value)&&!$("buying-options").querySelector("input"))renderBuyingMinerals(buyers.plan.orders.map(o=>({typeID:o.typeID,name:name(o.typeID)})),buyers.plan.orders);
  if(buyers&&(buyers.plan.enabled||!buyingCatalog)){$("buying-budget").value=String(buyers.plan.budgetISK);$("buying-reserve").value=String(buyers.plan.walletReserve);}
  $("buying-job").textContent=job?`${job.summary.quantity.toLocaleString()} × ${job.summary.name} · ${job.summary.cost.toLocaleString()} ISK`:buyingLabels[buyers?.status]||"Waiting for a restocking policy";
  $("buying-count").textContent=(buyers?.completedPurchases||0).toLocaleString();$("buying-spent").textContent=(buyers?.totalSpent||0).toLocaleString();
  $("buying-funding").textContent=buyers?`Sales allowance remaining: ${buyers.funding.salesAvailable.toLocaleString()} ISK. Policy: ${buyers.plan.spent.toLocaleString()} / ${buyers.plan.budgetISK.toLocaleString()} ISK spent. Wallet reserve: ${buyers.plan.walletReserve.toLocaleString()} ISK.`:"Only realized net crew sales income can fund purchases.";
  $("buying-availability").textContent=(buyers?.availability||[]).map(a=>`${name(a.typeID)}: ${buyingLabels[a.status]||a.status} (${a.stock.toLocaleString()} in hangar)`).join(". ");
  $("buying-profit").textContent=profitText(job?.summary.profit||buyers?.profit||[])||"Purchases require a profitable factory recipe at current local prices. Accepted trades finish if prices change.";
  $("buying-priority").textContent=buyers?.priority?`Restock priority: ${buyers.priority.name}${Number.isFinite(buyers.priority.profitPerHour)?` · ${buyers.priority.profitPerHour.toLocaleString(undefined,{maximumFractionDigits:2})} ISK per production hour`:""}. Batch shortages come first.`:buyers?.status==="production_targets_covered"?"Finished goods and accepted jobs cover the current production targets.":"Procurement follows the best profitable production opportunity. Existing surplus and incoming goods count toward demand.";
  $("pause-buying").textContent=buyers?.paused?"Resume purchases":"Pause new purchases";
  $("buying-history").replaceChildren();for(const purchase of (buyers?.history||[]).slice(0,5)){const article=document.createElement("article"),p=document.createElement("p");article.textContent=purchase.rejected?`${purchase.name}: purchase cancelled, no net charge`:`${purchase.quantity.toLocaleString()} × ${purchase.name} bought · ${purchase.cost.toLocaleString()} ISK`;p.textContent=`${new Date(purchase.completedAtMs).toLocaleString()} · ${purchase.unitPrice.toLocaleString()} ISK per unit`;article.append(p);$("buying-history").append(article);}
  if(job?.recoveryError)message(job.recoveryError,true);renderRoster();lock();
}
function render(data) {
  state = data; const crew = data.crew, job = crew?.job, standing = crew?.standingOrder;
  $("hauling-skill").textContent = crewSkillText(crew, "travel legs", job?.skillAtStart) + equipmentText(crew?.equipment);
  $("capacity").textContent = `Courier hold: ${(crew?.capacityM3 || 1000).toLocaleString()} m³. One packaged stack per trip.`;
  const paused = standing?.enabled ? standing.paused : job?.pausedAtMs != null;
  $("create-panel").hidden = !data.enabled || Boolean(crew);
  $("operations").hidden = !crew;
  $("crew-name").textContent = crew?.name || "A small team. A longer reach.";
  const supplyStatus = resourceLabels[standing?.status] || profitLabels[standing?.status] || "Waiting for source stock";
  $("crew-state").textContent = crew?.confirmationPending ? "Awaiting confirmation" : job ? job.recoveryError ? "Awaiting confirmation" : paused ? "Paused" : "Under way" : standing?.enabled ? paused ? "Paused" : standing.followProduction ? supplyStatus : "Waiting for stock" : crew ? "At station" : "Stand by";
  renderRoster();
  if (crew) {
    $("journey-title").textContent = paused ? "Crew paused" : job ? "Current journey" : standing?.enabled ? standing.followProduction ? supplyStatus : "Waiting for supply" : "Ready for assignment";
    $("station-name").textContent = job ? `${stationName(job.sourceStation, job.sourceStationID)} → ${stationName(job.destinationStation, job.destinationStationID)}` : stationName(crew.station, crew.stationID);
    $("journey-timing").textContent = job ? job.phase === "travelling" ? `${Math.max(0, job.route.length - 1 - job.legIndex)} jumps remaining` : "Confirming cargo" : "Crew standing by";
    $("route").replaceChildren();
    for (const [index, systemID] of (job?.route || [crew.systemID]).entries()) {
      const item = document.createElement("li"), system = job?.routeSystems?.[index] || crew.system;
      item.textContent = system?.solarSystemName || system?.name || `System ${systemID}`;
      item.classList.toggle("reached", index <= (job?.legIndex || 0)); item.classList.toggle("current", index === (job?.legIndex || 0)); $("route").append(item);
    }
    $("cargo-status").textContent = job?.cargo ? `${job.cargo.quantity.toLocaleString()} × ${job.cargo.name} / ${job.cargo.volumeM3.toLocaleString()} m³ in crew custody` : "Cargo hold empty";
    $("pause").hidden = !standing?.enabled && (!job || job.phase !== "travelling");
    $("pause").textContent = paused ? "Resume work" : "Pause work";
    $("standing-status").textContent = standing ?
      `${stationName(standing.sourceStation, standing.sourceStationID)} → ${stationName(standing.destinationStation, standing.destinationStationID)}. ${standing.completedDeliveries.toLocaleString()} ${standing.completedDeliveries === 1 ? "delivery" : "deliveries"} completed. ${standing.enabled ? standing.paused ? "Automation paused." : "Standing order active." : "Automation stopped."}` :
      "Choose cargo and a destination to establish a repeating supply route.";
    if (standing?.enabled) $("source-reserve").value = String(standing.sourceReserve);
    $("stop-automation").textContent = job ? "Stop after this trip" : "Stop automation";
    $("follow-courier").textContent = standing?.followProduction ? "Rotate materials" : "Follow production";
    const priority = job?.priority || standing?.priority;
    $("courier-priority").textContent = !standing?.followProduction ? "Rotating available materials above the source reserve. Follow production to haul needed minerals first." :
      job && !job.priority ? "Following production after the accepted trip finishes." :
      job && priority ? `Following production · ${priority.quantity.toLocaleString()} ${priority.mineralName} for ${priority.name} · ${priority.phase === "batch" ? "batch shortage first" : "restocking mineral buffer"}.` :
      `Following production · ${supplyStatus}.`;
    const selectedCargo = $("cargo").value; $("cargo").replaceChildren(); option($("cargo"), "", "Travel without cargo");
    for (const item of data.cargo || []) option($("cargo"), item.itemID, `${item.quantity.toLocaleString()} × ${item.name} (${item.volumeM3.toLocaleString()} m³)`);
    if ([...$("cargo").options].some((item) => item.value === selectedCargo)) $("cargo").value = selectedCargo;
    $("history").replaceChildren();
    if (!data.history?.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "Your first completed journey will appear here."; $("history").append(p); }
    for (const trip of data.history || []) { const article = document.createElement("article"), detail = document.createElement("p");
      article.textContent = trip.cargo ? `${trip.cargo.quantity.toLocaleString()} × ${trip.cargo.name} delivered` : "Crew repositioned";
      detail.textContent = `${stationName(trip.destinationStation || (trip.destinationStationID === crew.stationID ? crew.station : null), trip.destinationStationID)} • ${new Date(trip.completedAtMs).toLocaleString()}`; article.append(detail); $("history").append(article); }
    if (job?.recoveryError) message(job.recoveryError.message, true);
  }
  if (!data.enabled) message("Crew operations are disabled in this server's configuration.", true);
  $("dispatch").textContent = $("cargo").value ? "Issue delivery order" : "Issue travel order";
  supplyTypes(); lock();
}
async function refresh() {
  const owner = identity(), generation = scope;
  if (!owner.characterID) return;
  const params = new URLSearchParams(owner);
  const [data, miners, refiners, manufacturers, sellers, buyers, equipment] = await Promise.all([request(`/crew?${params}`), request(`/crew/mining?${params}`).catch(() => null), request(`/crew/refining?${params}`).catch(() => null), request(`/crew/manufacturing?${params}`).catch(() => null), request(`/crew/selling?${params}`).catch(() => null), request(`/crew/buying?${params}`).catch(() => null), request(`/crew/equipment?${params}`).catch(() => null)]);
  if (generation === scope && !busy) { render(data); renderMining(miners); renderRefining(refiners); renderManufacturing(manufacturers); renderSelling(sellers); renderBuying(buyers); renderEquipment(equipment); }
  try {
    const facts = await request(`/crew/universe?${params}`);
    if (generation !== scope) return;
    $("universe-actors").replaceChildren();
    const labels = { hauling: "Hauling cargo", returning: "Returning to supply source", outbound: "Travelling to belt", mining: "Extracting ore", ready: "Preparing next load", stopped: "At home", depleted: "Ore depleted", waiting_for_stock: "Waiting for source stock", docked: "At station", travelling: "Travelling", paused: "Work paused", awaiting_confirmation: "Awaiting cargo confirmation" };
    for (const actor of facts.universe.actors) {
      const item = document.createElement("li"), detail = document.createElement("span"); item.textContent = actor.name;
      const extra = { ...manufacturingLabels, ...sellingLabels, ...buyingLabels, manufacturing: "Building ammo and modules", refining: "Refining ore", waiting_for_ore: "Waiting for ore", insufficient_funds: "Needs ISK for operations" };
      const activity = actor.activity === "returning" && actor.crewID.startsWith("mining:") ? "Bringing ore home" : actor.crewID.startsWith("buying:") ? buyingLabels[actor.activity] || labels[actor.activity] || actor.activity : actor.crewID.startsWith("manufacturing:") ? manufacturingLabels[actor.activity] || extra[actor.activity] || labels[actor.activity] || actor.activity : actor.crewID.startsWith("selling:") ? sellingLabels[actor.activity] || labels[actor.activity] || actor.activity : labels[actor.activity] || extra[actor.activity] || actor.activity;
      detail.textContent = `${actor.role} • ${activity}${actor.skill ? ` • ${actor.skill.skill} ${actor.skill.level}/5 · ${actor.skill.xp} XP` : ""}`; item.append(detail); $("universe-actors").append(item);
    }
    if (!facts.universe.actors.length) $("universe-actors").textContent = "Establish a crew to populate its universe activity.";
  } catch (error) { $("universe-actors").textContent = error.status === 404 ? "Restart the backend to load universe activity." : "Universe activity is temporarily unavailable."; }
}
async function send(type, payload, target = "courier") {
  if (busy || pending) return;
  pending = { ...identity(), target, command: { commandID: crypto.randomUUID(), expectedRevision: (target === "equipment" ? equipmentState?.revision : target === "mining" ? miningState?.revision : target === "refining" ? refiningState?.revision : target === "manufacturing" ? manufacturingState?.revision : target === "selling" ? sellingState?.revision : target === "buying" ? buyingState?.revision : state?.revision) || 0, type, payload } };
  sessionStorage.setItem("xcommand.pending", JSON.stringify(pending));
  await retry();
}
async function retry() {
  if (!pending || busy) return;
  busy = true; lock();
  try {
    const miningOrder = pending.target === "mining", refiningOrder = pending.target === "refining", manufacturingOrder = pending.target === "manufacturing", sellingOrder = pending.target === "selling", buyingOrder = pending.target === "buying";
    const data = await request(pending.target === "equipment" ? "/crew/equipment/orders" : miningOrder ? "/crew/mining/orders" : refiningOrder ? "/crew/refining/orders" : manufacturingOrder ? "/crew/manufacturing/orders" : sellingOrder ? "/crew/selling/orders" : buyingOrder ? "/crew/buying/orders" : "/crew/orders", pending);
    const equipmentOrder = pending.target === "equipment";
    pending = null; sessionStorage.removeItem("xcommand.pending"); busy = false;
    if (equipmentOrder) renderEquipment(data); else if (miningOrder) renderMining(data); else if (refiningOrder) renderRefining(data); else if (manufacturingOrder) renderManufacturing(data); else if (sellingOrder) renderSelling(data); else if (buyingOrder) renderBuying(data); else render(data);
    message(data.replayed ? "Order already accepted. Crew state refreshed." : "Order accepted.");
    void refresh().catch(() => {});
  } catch (error) {
    if ([400, 404, 409].includes(error.status)) { pending = null; sessionStorage.removeItem("xcommand.pending"); }
    message(error.message + (pending ? " Use Retry last order when the connection returns." : ""), true);
  } finally { busy = false; lock(); }
}
async function loadCharacters() {
  scope += 1; state = null; equipmentState = null; miningState = null; miningSites = null; miningHomes = []; refiningState = null; refiningRecipes = null;
  manufacturingState = null; manufacturingCatalog = null; factoryStations = []; $("blueprint-options").replaceChildren(); sellingState = null; sellingCatalog = null; sellingStations = []; $("selling-options").replaceChildren(); buyingState=null;buyingCatalog=null;$("buying-options").replaceChildren();
  $("operations").hidden = true; $("create-panel").hidden = true;
  const accountID = Number($("account").value); $("character").replaceChildren();
  if (!accountID) return;
  const data = await request(`/characters?accountID=${accountID}`);
  for (const pilot of data.characters || []) option($("character"), pilot.characterID, pilot.characterName || `Pilot ${pilot.characterID}`);
  if (pending) $("character").value = String(pending.characterID);
  $("character").disabled = !data.characters?.length;
  if (!data.characters?.length) message("This account has no pilots yet. Create a character in EVE when you are ready.");
  else { message("Connected to your crew records."); await refresh(); }
}
async function connect() {
  try {
    sessionStorage.setItem("xcommand.token", $("token").value.trim());
    const data = await request("/accounts"); $("account").replaceChildren();
    for (const account of data.accounts || []) option($("account"), account.accountID, account.username || account.userName || `Account ${account.accountID}`);
    $("account").disabled = !data.accounts?.length;
    if (pending) $("account").value = String(pending.accountID);
    $("connection").textContent = "Local server connected";
    if (!data.accounts?.length) message("No accounts found. Create your pilot in EVE when you are ready.");
    else await loadCharacters();
  } catch (error) { $("connection").textContent = "Connection unavailable"; message(error.message, true); }
}
$("connect-form").addEventListener("submit", (event) => { event.preventDefault(); void connect(); });
$("account").addEventListener("change", () => void loadCharacters().catch((error) => message(error.message, true)));
$("character").addEventListener("change", () => { scope += 1; state = null; miningState = null; miningSites = null; miningHomes = []; refiningState = null; refiningRecipes = null; manufacturingState = null; manufacturingCatalog = null; factoryStations = []; $("blueprint-options").replaceChildren(); sellingState = null; sellingCatalog = null; sellingStations = []; $("selling-options").replaceChildren(); buyingState=null;buyingCatalog=null;$("buying-options").replaceChildren(); void refresh().catch((error) => message(error.message, true)); });
$("create-form").addEventListener("submit", (event) => { event.preventDefault(); void send("create", { name: $("new-name").value }); });
$("pause").addEventListener("click", () => void send((state.crew.standingOrder?.enabled ? state.crew.standingOrder.paused : state.crew.job?.pausedAtMs != null) ? "resume" : "pause", {}));
$("follow-courier").addEventListener("click", () => void send("prioritize", {enabled: !state.crew.standingOrder.followProduction}));
$("retry").addEventListener("click", () => void retry());
$("cargo").addEventListener("change", () => { $("dispatch").textContent = $("cargo").value ? "Issue delivery order" : "Issue travel order"; lock(); });
$("automate").addEventListener("click", () => {
  const selection = $("supply-type").value;
  const typeIDs = selection === "refinery" ? refiningState.refining.plan.recipe.outputs.map(o => o.typeID) : selection === "route" ? state.crew.standingOrder.typeIDs : [Number(selection)];
  const typeID = typeIDs[0];
  const destinationStationID = Number($("destination").value), sourceReserve = Number($("source-reserve").value);
  if (!typeID || !destinationStationID || !Number.isSafeInteger(sourceReserve) || sourceReserve < 0) { message("Choose a material, a destination and a nonnegative source reserve.", true); return; }
  const sourceStationID = miningState?.mining?.plan.typeID === typeID ? miningState.mining.plan.homeStationID : state.crew.stationID;
  const mineral = refiningState?.refining?.plan.recipe.outputs.some(output => output.typeID === typeID);
  void send("automate", { sourceStationID: selection === "route" ? state.crew.standingOrder.sourceStationID : mineral ? refiningState.refining.plan.stationID : sourceStationID, destinationStationID, typeID, ...(typeIDs.length > 1 ? { typeIDs } : {}), sourceReserve });
});
$("supply-type").addEventListener("change", () => { supplyTypes(); lock(); });
$("mining-home-form").addEventListener("submit", async event => {
  event.preventDefault(); const generation = scope;
  busy = true; lock();
  try {
    const data = await request(`/crew/stations?${new URLSearchParams({ ...identity(), q: $("mining-home-search").value })}`);
    if (generation !== scope) return;
    miningHomes = data.stations; miningSites = null; renderMining(miningState);
    if (miningHomes.length) $("mining-home").value = String(miningHomes[0].stationID);
    $("mining-belt").replaceChildren(); option($("mining-belt"), "", "Survey belts first"); renderOres();
    message(miningHomes.length ? "Choose a home station, then survey its local belts." : "No matching home stations found.");
  } catch (error) { message(error.message, true); } finally { busy = false; lock(); }
});
$("load-belts").addEventListener("click", async () => {
  const generation = scope, homeStationID = Number($("mining-home").value);
  if (!homeStationID) return;
  busy = true; lock();
  try {
    const data = await request(`/crew/mining/sites?${new URLSearchParams({ ...identity(), homeStationID })}`);
    if (generation !== scope) return; miningSites = { ...data, homeStationID };
    $("mining-belt").replaceChildren(); option($("mining-belt"), "", data.sites.length ? "Choose a belt" : "No asteroid belts in this system");
    for (const site of data.sites) option($("mining-belt"), site.beltID, site.name);
    if (data.sites.length === 1) { $("mining-belt").selectedIndex = 1; renderOres(); }
    else { $("mining-ore").replaceChildren(); option($("mining-ore"), "", "Choose a belt"); }
  } catch (error) { message(error.message, true); } finally { busy = false; lock(); }
});
$("mining-home").addEventListener("change", () => { miningSites = null; $("mining-belt").replaceChildren(); option($("mining-belt"), "", "Survey belts first"); renderOres(); });
$("mining-belt").addEventListener("change", renderOres);
$("mining-ore").addEventListener("change", lock);
$("start-mining").addEventListener("click", () => {
  const payload = { homeStationID: Number($("mining-home").value), beltID: Number($("mining-belt").value), typeID: Number($("mining-ore").value) };
  if (!Object.values(payload).every(Number.isSafeInteger) || !Object.values(payload).every(value => value > 0)) { message("Choose a home station, belt and ore first.", true); return; }
  void send("start", payload, "mining");
});
$("pause-mining").addEventListener("click", () => void send(miningState.mining.paused ? "resume" : "pause", {}, "mining"));
$("stop-mining").addEventListener("click", () => void send("stop", {}, "mining"));
$("follow-mining").addEventListener("click",()=>void send("prioritize",{enabled:!miningState.mining.plan.followProduction},"mining"));
$("load-refining").addEventListener("click", async () => {
  const generation = scope, stationID = Number($("refining-station").value); if (!stationID) return;
  busy = true; lock();
  try {
    const data = await request(`/crew/refining/options?${new URLSearchParams({ ...identity(), stationID })}`);
    if (generation !== scope) return; refiningRecipes = { ...data, stationID };
    $("refining-ore").replaceChildren(); option($("refining-ore"), "", data.recipes.length ? "Choose ore" : "No supported ore found here");
    for (const recipe of data.recipes) option($("refining-ore"), recipe.typeID, recipe.name);
    if (data.recipes.length === 1) $("refining-ore").selectedIndex = 1; renderRecipe();
  } catch (error) { message(error.message, true); } finally { busy = false; lock(); }
});
$("refining-station").addEventListener("change", () => { refiningRecipes = null; $("refining-ore").replaceChildren(); option($("refining-ore"), "", "Load recipes first"); renderRecipe(); });
$("refining-ore").addEventListener("change", renderRecipe);
$("start-refining").addEventListener("click", () => {
  const payload = { stationID: Number($("refining-station").value), typeID: Number($("refining-ore").value), oreReserve: Number($("refining-reserve").value) };
  if (!payload.stationID || !payload.typeID || !Number.isSafeInteger(payload.oreReserve) || payload.oreReserve < 0) { message("Choose a refinery, ore and nonnegative reserve.", true); return; }
  void send("start", payload, "refining");
});
$("pause-refining").addEventListener("click", () => void send(refiningState.refining.paused ? "resume" : "pause", {}, "refining"));
$("stop-refining").addEventListener("click", () => void send("stop", {}, "refining"));
$("follow-refining").addEventListener("click",()=>void send("prioritize",{enabled:!refiningState.refining.plan.followProduction},"refining"));
async function loadBlueprints() {
  const generation = scope, stationID = Number($("manufacturing-station").value); if (!stationID) return;
  busy = true; lock();
  try {
    const data = await request(`/crew/manufacturing/catalog?${new URLSearchParams({ ...identity(), stationID })}`);
    if (generation !== scope) return; manufacturingCatalog = { ...data, stationID };
    renderBlueprints(data.blueprints, manufacturingState?.manufacturing?.plan?.orders || []);
    message(data.blueprints.length ? "Choose blueprints, batch sizes and stock targets." : "No supported blueprints at this factory. Add the starter pack or move your own blueprints here.");
  } catch (error) { message(error.message, true); } finally { busy = false; lock(); }
}
$("load-blueprints").addEventListener("click", () => void loadBlueprints());
$("starter-blueprints").addEventListener("click", async () => { await send("starter", { stationID: Number($("manufacturing-station").value) }, "manufacturing"); if (!pending && manufacturingState?.manufacturing?.starter?.complete) await loadBlueprints(); });
$("manufacturing-station").addEventListener("change", () => { manufacturingCatalog = null; $("blueprint-options").replaceChildren(); lock(); });
$("factory-search-form").addEventListener("submit", async event => {
  event.preventDefault(); const generation = scope; busy = true; lock();
  try {
    const data = await request(`/crew/stations?${new URLSearchParams({ ...identity(), q: $("factory-search").value })}`);
    if (generation !== scope) return; factoryStations = data.stations; manufacturingCatalog = null; $("blueprint-options").replaceChildren(); renderManufacturing(manufacturingState);
    if (factoryStations.length) $("manufacturing-station").value = String(factoryStations[0].stationID);
    message(factoryStations.length ? "Choose a station, then load blueprints to check its factory." : "No matching station found.");
  } catch (error) { message(error.message, true); } finally { busy = false; lock(); }
});
$("start-manufacturing").addEventListener("click", () => {
  const orders = [...$("blueprint-options").querySelectorAll(".blueprint-choice")].filter(row => row.querySelector(".blueprint-selected").checked).map(row => ({ blueprintID: Number(row.dataset.blueprintId), runs: Number(row.querySelector(".blueprint-runs").value), targetStock: Number(row.querySelector(".blueprint-target").value) }));
  if (!orders.length || orders.length > 8 || orders.some(o => !Number.isSafeInteger(o.runs) || o.runs < 1 || o.runs > 1000 || !Number.isSafeInteger(o.targetStock) || o.targetStock < 1 || o.targetStock > 1000000)) { message("Choose up to eight blueprints with positive whole-number batch sizes and stock targets.", true); return; }
  void send("start", { stationID: Number($("manufacturing-station").value), orders }, "manufacturing");
});
$("pause-manufacturing").addEventListener("click", () => void send(manufacturingState.manufacturing.paused ? "resume" : "pause", {}, "manufacturing"));
$("stop-manufacturing").addEventListener("click", () => void send("stop", {}, "manufacturing"));
$("load-selling").addEventListener("click", async () => {
  const generation = scope, stationID = Number($("selling-station").value); if (!stationID) return; busy = true; lock();
  try { const data = await request(`/crew/selling/catalog?${new URLSearchParams({...identity(),stationID})}`); if (generation !== scope) return; sellingCatalog = {...data,stationID}; renderSellingProducts(data.products, sellingState?.selling?.plan.orders || []); message("Choose products, reserves, batch limits and minimum unit prices."); }
  catch(error) { message(error.message,true); } finally { busy = false; lock(); }
});
$("selling-station").addEventListener("change", () => { sellingCatalog = null; $("selling-options").replaceChildren(); lock(); });
$("selling-search-form").addEventListener("submit", async event => {
  event.preventDefault(); const generation = scope; busy = true; lock();
  try { const data = await request(`/crew/stations?${new URLSearchParams({...identity(),q:$("selling-search").value})}`); if (generation !== scope) return; sellingStations = data.stations; sellingCatalog = null; $("selling-options").replaceChildren(); renderSelling(sellingState); if(sellingStations.length) $("selling-station").value = String(sellingStations[0].stationID); message(sellingStations.length ? "Choose a selling station, then load its buyers." : "No matching station found."); }
  catch(error) { message(error.message,true); } finally { busy = false; lock(); }
});
$("start-selling").addEventListener("click", () => {
  const orders = [...$("selling-options").querySelectorAll(".blueprint-choice")].filter(row => row.querySelector(".selling-selected").checked).map(row => ({ typeID:Number(row.dataset.typeId),reserve:Number(row.querySelector(".selling-reserve").value),batchSize:Number(row.querySelector(".selling-batch").value),minimumPrice:Number(row.querySelector(".selling-price").value) }));
  if (!orders.length || orders.length > 8 || orders.some(o => !Number.isSafeInteger(o.reserve) || o.reserve < 0 || o.reserve > 1000000000 || !Number.isSafeInteger(o.batchSize) || o.batchSize < 1 || o.batchSize > 10000 || !Number.isFinite(o.minimumPrice) || o.minimumPrice < 0.01 || o.minimumPrice > 100000000)) { message("Choose up to eight products with valid reserves, batch limits and positive unit prices.",true); return; }
  void send("start", {stationID:Number($("selling-station").value),orders}, "selling");
});
$("pause-selling").addEventListener("click", () => void send(sellingState.selling.paused ? "resume" : "pause", {}, "selling"));
$("stop-selling").addEventListener("click", () => void send("stop", {}, "selling"));
$("load-buying").addEventListener("click",async()=>{
  const generation=scope,stationID=Number($("buying-station").value);if(!stationID)return;busy=true;lock();
  try{const data=await request(`/crew/buying/catalog?${new URLSearchParams({...identity(),stationID})}`);if(generation!==scope)return;buyingCatalog={...data,stationID};renderBuyingMinerals(data.minerals,buyingState?.buying?.plan.orders||[]);message(data.minerals.length?"Choose mineral buffers, purchase limits, price ceilings and a spending cap.":"Activate a manufacturing queue at this station first.");}
  catch(error){message(error.message,true);}finally{busy=false;lock();}
});
$("buying-station").addEventListener("change",()=>{buyingCatalog=null;$("buying-options").replaceChildren();lock();});
$("start-buying").addEventListener("click",()=>{
  const orders=[...$("buying-options").querySelectorAll(".blueprint-choice")].filter(row=>row.querySelector(".buying-selected").checked).map(row=>({typeID:Number(row.dataset.typeId),targetStock:Number(row.querySelector(".buying-target").value),batchSize:Number(row.querySelector(".buying-batch").value),maximumPrice:Number(row.querySelector(".buying-price").value)}));
  const payload={stationID:Number($("buying-station").value),walletReserve:Number($("buying-reserve").value),budgetISK:Number($("buying-budget").value),orders};
  if(!orders.length||orders.length>8||!Number.isFinite(payload.walletReserve)||payload.walletReserve<0||!Number.isFinite(payload.budgetISK)||payload.budgetISK<0.01||payload.budgetISK>1000000000||orders.some(o=>!Number.isSafeInteger(o.targetStock)||o.targetStock<1||o.targetStock>1000000||!Number.isSafeInteger(o.batchSize)||o.batchSize<1||o.batchSize>100000||!Number.isFinite(o.maximumPrice)||o.maximumPrice<0.01||o.maximumPrice>100000000)){message("Choose valid mineral targets, whole-number batch limits, positive price ceilings and a spending cap.",true);return;}
  void send("start",payload,"buying");
});
$("pause-buying").addEventListener("click",()=>void send(buyingState.buying.paused?"resume":"pause",{},"buying"));
$("stop-buying").addEventListener("click",()=>void send("stop",{},"buying"));
$("start-equipment").addEventListener("click", () => void send("start", { budgetISK: Number($("equipment-budget").value), walletReserve: Number($("equipment-reserve").value), workingCapitalISK: Number($("equipment-capital").value), reinvestPercent: Number($("equipment-share").value), maxPaybackHours: Number($("equipment-payback").value) }, "equipment"));
$("stop-equipment").addEventListener("click", () => void send("stop", {}, "equipment"));
$("stop-automation").addEventListener("click", () => void send("stop", {}));
$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const generation = scope;
  try { const data = await request(`/crew/stations?${new URLSearchParams({ ...identity(), q: $("station-search").value })}`);
    if (generation !== scope) return; $("destination").replaceChildren(); option($("destination"), "", data.stations.length ? "Choose destination" : "No matching stations");
    for (const station of data.stations) option($("destination"), station.stationID, stationName(station, station.stationID));
  } catch (error) { message(error.message, true); }
});
$("order-form").addEventListener("submit", (event) => { event.preventDefault();
  const destinationStationID = Number($("destination").value); if (!destinationStationID) { message("Choose a destination station first.", true); return; }
  const itemID = Number($("cargo").value); void send(itemID ? "deliver" : "travel", { destinationStationID, ...(itemID ? { itemID } : {}) });
});
setInterval(() => { if (!document.hidden && !busy) void refresh().catch((error) => message(error.message, true)); }, 2500);
void connect();
