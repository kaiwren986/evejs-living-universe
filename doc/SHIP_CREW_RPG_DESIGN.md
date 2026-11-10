# EVE JS ship crews and industrial RPG

Design direction recorded on November 2, 2026.

Build a gritty space RPG and trading game around operating a working ship,
employing people, fulfilling contracts and developing a place in the local
economy. A capable, familiar ship should support a lasting career. Character
progress should include trusted contacts, crew experience, useful knowledge,
specialist equipment and business relationships alongside pilot skills and hulls.

## Agreed direction

- Crew management must extend beyond skill ratings and passive bonuses.
- Server and client changes are within scope.
- All player-facing systems must be accessible through native in-game UI.
  No external browser, web dashboard, embedded web app or companion website
  is required to play these systems. The existing X-Command browser interface
  is a historical implementation surface, not the intended player interface.
- Native client integration is the first implementation proof. A working
  backend or browser screen alone does not complete a gameplay feature.

The mechanics and sequencing below are proposals under that direction. They
are not a claim that ship engineering or the RPG loop is already implemented.

## The recurring play loop

Meet a contact or discover an opportunity. Inspect its requirements, expected
margin and risks. Prepare the ship, supplies and watches. Survey, trade, haul,
mine or salvage. Manage events during the voyage. Deliver or renegotiate.
Pay costs, service the vessel and decide what to improve before the next job.

Completion changes the world locally: a customer receives real stock, a crew
member gains relevant experience, the ship has a service history, and a contact
remembers whether the player honoured the agreement. Missions should connect
to these people and material flows.

## Crew as people and work capacity

Each person has a persistent identity, qualifications, current assignment,
availability, condition and relevant history. Named officers lead departments;
larger complements use specialist teams and staffing totals so that capital
ships remain manageable.

Skills influence competence. Staffing determines how much work can happen at
once. Fatigue changes who is fit for duty. Injury can remove particular
capabilities. Familiarity with a vessel improves work aboard that vessel.
Trust, morale and cohesion should respond to understandable events such as
repeated overwork, reliable pay, shared danger and the loss of a colleague.

| Department | Work and responsibilities | Captain's decisions |
| --- | --- | --- |
| Engineering | Power equipment, cooling, inspections and machinery | Allocate work, reduce load, isolate equipment, authorise temporary repairs |
| Damage control | Diagnose faults, contain damage and repair modules | Choose repair priorities and how many people to divert |
| Industrial operations | Extraction, processing and material handling | Set operating limits and manage bottlenecks |
| Sensors and survey | Calibration, observations and interpretation | Choose survey targets, scope and acceptable confidence |
| Medical and life support | Treatment, recovery and environmental equipment | Preserve staffing, allocate treatment and decide when to return |
| Logistics | Spares, consumables, cargo preparation and servicing | Set reserves, buy supplies and plan voyage endurance |

A person or team can only perform one incompatible assignment at a time. Moving
technicians from a watch to a repair must visibly change both departments'
capacity. Existing crew identities, XP, equipment and accepted economic jobs
must survive the introduction of hull assignments. Existing jobs need an
explicit finish, pause or reassignment policy before their people transfer.

Standing orders handle routine work: rotate watches, preserve reserves, inspect
idle machinery, stop equipment above a thermal limit, and request the captain's
decision when a policy cannot resolve the problem.

## Ship condition and engineering

The ship has installed equipment, operating history, outstanding work and
consumable reserves. Keep genuine engine values such as capacitor, module
damage and rack heat distinct from new simulated values such as coolant
pressure or pump condition. EVE's fitting power-grid budget is not an existing
reactor power-flow simulation; a reactor model would be a deliberate addition.

Faults should follow traceable causes: sustained load, overheating, damage,
neglected inspection or an explicitly risky procedure. Give useful symptoms,
diagnosis and operating limits. Small faults should create choices before
they become major failures. Routine maintenance should be delegated.

Temporary repairs restore limited operation and leave a recorded restriction.
Proper repairs consume appropriate materials and time. Salvaged and rebuilt
equipment can have provenance, condition and service requirements. Improved
equipment should offer useful specialisations and tradeoffs.

For example, cooling performance falls during prolonged mining. The captain
can reduce extraction load while the engineering watch investigates, shut down
the affected equipment for repair, divert a second team from other work, or
authorise a limited bypass. A spare pump permits a different response from a
hold containing only repair consumables. The resulting heat and module state
must affect actual mining operation.

## Trading as an occupation

Contracts should expose quantity, destination, deadline, payment, collateral,
known hazards and expected operating costs before acceptance. The voyage
estimate should include crew costs, servicing, consumables, cargo capacity and
travel. Estimates and firm quotes must be distinguishable.

Build on the existing market, contract, wallet and inventory authorities:

- Delivery moves or consumes the actual goods specified by the agreement.
- Payment and collateral have explicit counterparties and durable settlement.
- Stock, demand, deadlines and contract terms constrain opportunities.
- Partial fulfilment, delay and renegotiation have agreed outcomes.
- Supply contracts can support production, repairs and shortages elsewhere.

Crew can carry out delegated procurement and hauling under budgets, reserves
and risk policies. The captain selects opportunities and handles exceptions.
Staffing and operating costs should not turn each purchase into a manual chore.

Useful proposed trading specialisations include reliable bulk supply, urgent
industrial parts, remote servicing, salvage recovery, sensitive cargo and
survey information. Smuggling and salvage claims would need explicit law,
inspection and ownership rules before rewards depend on them.

## RPG progression and relationships

Progress can come from becoming a dependable supplier, finding productive
ground, restoring a damaged vessel, mentoring a specialist or earning access
to a workshop. Relationships belong to people and organisations with particular
interests. A dockmaster, quartermaster, mechanic and independent broker can
offer different opportunities even within one station.

Contacts remember relevant outcomes. Reliable deliveries may earn repeat
business, better terms or an introduction. Mishandled cargo can produce a
repair obligation or damage a specific relationship. Negotiation should offer
concrete exchanges such as a longer deadline for less pay or partial delivery
against reduced collateral.

Crew stories grow from work: someone recovering from an accident, an apprentice
qualifying for watch duty, a chief engineer recommending an overhaul, or a
trusted crewmate asking the captain to take a job. These stories should affect
assignments or opportunities and remain understandable in the crew record.

Information is another form of progress. Survey results have provenance and
age; commercial information has an observation time and confidence. Better
knowledge should help the captain make a decision. Display only measurements
the simulation supports; new geological or engineering quantities need their
own defined model.

Grit comes from continuity and consequences. Provide warnings, recovery paths
and choices after a setback. Proposed starting rules avoid crew starvation,
wage spirals or random deaths solely because the player logged off. Offline
work and recovery need explicit bounded policies.

## Native in-game interface

Add a Ship and Crew entry to the native client menu and a Manage Crew action
on appropriate owned ships. The window follows a selected hull and contains:

| In-game surface | Information and actions |
| --- | --- |
| Ship overview | Real ship condition, departmental readiness, active restrictions and urgent work |
| Crew and watches | Roster, department assignments, duty/rest status and transfers |
| Engineering | System schematic, faults, diagnosis, repair queue, parts and operating limits |
| Voyage and contracts | Accepted obligations, cargo, estimated margin, route and endurance |
| Contacts and journal | Relationships, offers, messages and consequential ship/crew history |

Use native game controls and windows. A schematic with selected modules and
zones is sufficient for the first engineering interface. Custom 3D interiors
are a separate art and interaction project, not a prerequisite for management.

Context actions should open the same authoritative system from the fitting
window, inventory, owned-ship lists and station interactions as appropriate.
HUD alerts identify a problem and open the relevant department or work order.
Routine events belong in a bounded log; interruptive alerts are reserved for
decisions or immediate danger. NPC offers and negotiations should be available
through in-game conversations and contract screens.

The server validates orders and owns results. The client shows pending,
accepted, failed and completed states; it must not declare a repair complete
because a local countdown ended. All gameplay acceptance checks must work
with browsers closed.

## Existing implementation seams

- [Crew automation](CREW_AUTOMATION.md) and [progression](CREW_PROGRESSION.md)
  provide persistent people, jobs and economic integration. Current crews are
  virtual; per-hull staffing, watches and medical/engineering state are new work.
- [Equipment reinvestment](CREW_EQUIPMENT.md) supplies existing team upgrades
  and purchase accounting that must be preserved.
- `server/src/space/runtime/moduleHeat.js` handles rack heat, module damage,
  burnout and fitted-module repair.
- `server/src/space/runtime/entityCapacitor.js` handles capacitor state and use;
  `shipModuleFuel.js` handles fuel-consuming module activations.
- `server/src/services/dogma/dogmaService/moduleRepair.js` uses nanite paste,
  but its active repairs are session-backed. Persistent crew repairs need
  durable work records and reconciliation across restart.
- Existing contract custody, settlement, agent and standing services provide
  integration points for material obligations and relationships. The proposed
  RPG connections are not already wired into them.
- `server/src/_secondary/express/crewGateway.js` exposes the current browser
  interface. Its gameplay services can be reused behind a native-client
  command interface; adding browser pages does not satisfy this design.
- Client tools target a specific copied local client. A new native window,
  command transport, deployment and compatible server/client feature contract
  need an end-to-end proof before broader UI work proceeds.

Engineering must affect the existing authoritative ship systems. Preserve
inventory conservation, wallet receipts and ownership checks. Save crew
assignments and repair intentions durably, and make retries unable to consume
parts, pay wages or complete work twice. Add new state through the current
store/owner boundaries rather than a second ship or cargo balance.

## Implementation sequence and acceptance

1. **Native client connection.** Load one native Ship and Crew window through
   the normal local launch path. Show the actual controlled ship and one
   server-owned crew assignment. Submit an acknowledged order and receive
   an authoritative update without using a browser. Verify client deployment
   and server compatibility together.
2. **Hull assignment and watches.** Assign existing people to one medium
   industrial ship. Add engineering duty/rest and a finite repair team.
   Preserve identities, existing progression and accepted jobs; prevent
   simultaneous incompatible assignments. Verify save/restart and transfer.
3. **One engineering incident.** Connect a defined cooling fault to actual
   rack heat and mining operation. Diagnose, isolate and repair it through
   the native window. Use real supplies; verify interruption and restart
   without free repairs or repeated charges.
4. **One complete commercial voyage.** Take an in-game supply contract from
   a named contact, prepare crew and reserves, acquire and deliver actual
   cargo, settle payment and costs, and update that contact's history.
5. **Broaden after the loop works.** Add more work types, medical recovery,
   relationships, trading specialisations and fleet delegation. Introduce
   larger complements and richer schematics with measured simulation budgets.

The first completed slice should make one familiar ship worth operating and
looking after. Its acceptance requires native client interaction, real ship
consequences, conserved goods and money, persistent people, and recovery after
restart. Backend tests remain essential development tools; they do not replace
that in-game proof.
