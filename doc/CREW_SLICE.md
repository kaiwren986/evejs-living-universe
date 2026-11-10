# X-Command: persistent courier crew

Standing supply orders and the shared universe actor directory are now part of
this slice. See [Crew automation and mining integration](CREW_AUTOMATION.md) for
current mining/supply behavior and limits.

See [crew refining](CREW_REFINING.md) for ore-to-mineral automation and the
manufacturing inventory handoff.

The first Living Universe slice adds one founding crew per character, virtual
station-to-station travel, delivery of native inventory stacks, and a local
X-Command browser interface. It does not require the old patch or X-Eve ledger.

## Test and preview without EVE

```powershell
npm run test:crew
npm run check:crew-world
npm run demo:x-command
```

The demo opens a disposable SQLite store under the Windows temporary directory,
seeds a practice pilot, 1,000 Tritanium and a finite Veldspar field, and serves
`http://127.0.0.1:40120/x-command`. It never opens the player's world database
or starts EVE. Its fictional Aster/Bracken/Cinder route takes six seconds per
crossing plus a final docking interval. Farpoint is deliberately disconnected
to exercise unavailable routes. Stop the terminal process with Ctrl+C when done.
Demo progress is disposable; production crew progress lives in the normal
gameStore SQLite database.

`check:crew-world` separately reads the installed static JSON to verify station
search and a Jita-to-New-Caldari route. It does not open the world database.

## Normal local server

The current local profile enables `crewOperationsEnabled` under `crew` in
`config/world.json`. A backend restart is required to load the new source;
starting or testing this feature does not require launching the EVE client.
With the normal stack running, visit:

```text
http://127.0.0.1:26002/x-command
```

Use the existing gateway token if one is configured, select an account and
pilot, then establish the crew while that character is docked at an NPC
station. The initial crew is a free founding allocation with two named
specialists and a 1,000 m³ virtual courier hold. No hull or items are granted
by the production feature. Pilot control remains with EVE while crew orders
use a separate owner service.

1. Find a destination by station name or numeric station ID.
2. Select one packaged cargo stack from the crew's current station hangar,
   or choose travel without cargo.
3. Issue the order. A delivery takes the complete stack into crew custody.
4. Follow the route, pause/resume if needed, and inspect the completed journey.
5. Delivered cargo appears in the same character's destination station hangar.

Only NPC stations and stargate routes of up to 32 jumps are supported. Default
travel time is 30 seconds per crossing plus one docking interval; the accepted
job retains its duration across config changes and restart. Active journeys
catch up when the server returns. Paused journeys retain their remaining time.
The clock is injectable for tests; global server/client time is not altered.

## Persistence and custody

`crewRuntime` is a SQLite-backed table owned by `service:crew` in the world
process. Each owner has one aggregate containing crew identity, route/custody
intent, bounded history and command receipts. A command ID and expected
revision reject conflicting retries and stale orders. Receipt IDs are hashed
before storage; receipts are retained rather than silently evicted.

The owner commits delivery intent before calling inventory. Reservation moves
the existing stack into a dedicated crew location through
`moveItemToLocationIdempotent`; delivery uses the same owner API to place it in
the destination hangar. Each inventory effect and its receipt share the native
inventory commit and durable fence. The crew advances only after that fence
succeeds. A post-effect failure is reconciled by retrying the same receipt,
including after restarting in a different process.

Known inventory notifications are sent to an active pilot after a durable
move. Notification failure does not repeat custody; reopening inventory
refreshes the authoritative state. Client notification/rendering behavior still
requires an in-game acceptance check.

Worker passes handle at most eight crews with a soft four-millisecond budget
between crews; one route advances at most eight transitions per pass. There is
a hard limit of 128 crews and 1,024 retained commands per owner in this slice.
Near the command limit, pause is refused while space remains for a final
resume. A full journal allows existing unpaused journeys to finish. Long-term
receipt archival and population growth are later work.

## Gateway integration

`GET /_evejs-web/v1/crew` returns crew, cargo, route and recent journeys.
`GET /_evejs-web/v1/crew/stations?q=...` searches stations.
Both require the existing gateway authorization and matching `accountID` and
`characterID`. `POST /_evejs-web/v1/crew/orders` accepts:

```json
{
  "accountID": 1,
  "characterID": 90001,
  "command": {
    "commandID": "unique-order-id",
    "expectedRevision": 0,
    "type": "create",
    "payload": { "name": "Wayfarer Logistics" }
  }
}
```

Orders: `create`, `travel`, `deliver`, `pause`, `resume`, `automate`, `stop`. Travel payloads contain
`destinationStationID`; delivery also contains `itemID`. Pause/resume use `{}`.
Mutations require same-origin JSON requests. The existing edge/owner method
allowlist carries crew calls to the world owner; edge workers do not open a
second writable crew store. Error codes preserve retry classification across
the IPC transport. X-Command retains a pending order ID for retry after a
temporary connection or persistence failure.

## Verified and remaining acceptance

The follow-on [manufacturing guide](CREW_MANUFACTURING.md) covers the complete
mining, refining, mixed-mineral hauling and automated native production chain.
The counts below describe this original crew slice.

`npm run test:crew` currently passes 26 tests. They use attested disposable
stores and the real SQLite/inventory owner, covering:

- custody, timed travel, pause/resume, capacity and ownership;
- command replay/conflict, stale revisions and late A/B/A retries;
- failed intent flush and cross-process recovery after both inventory effects;
- corrupt-state refusal and inactive-feature behavior;
- HTTP authorization/origin checks, static assets and serialized owner calls;
- retryable errors retaining their correct HTTP status across IPC;
- domain configuration hydration without booting the server.

Browser acceptance exercised creation, station search, cargo selection,
delivery completion, page reload, and pausing a return delivery. Desktop and
mobile layouts were inspected. No EVE client was launched.

The crew is currently virtual: physical NPC ships, combat/loss, crew wages,
market procurement, partial-stack hauling, structures and skill-point rewards
are outside this slice. Before adding physical ships, do one in-game check of
source cargo removal, destination cargo arrival and notification refresh while
the pilot stays logged in. Cargo must remain conserved across a backend restart.
