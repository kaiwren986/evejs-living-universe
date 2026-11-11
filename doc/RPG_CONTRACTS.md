# Generated contracts

EveJS RPG fork. A contract is a small story the local AI writes around facts
the server chooses, played out in a real combat site, with a payout.

Open **Crew Link → Contracts** in game. No browser, no chat commands.

## The loop

1. **Find work.** The director (`server/src/rpg/contracts/contractDirector.js`)
   picks a system within two jumps, the local pirate faction, forces sized to
   your hull (tier 1 frigate … tier 5 battleship) and the pay.
2. **The story.** The writer (`contractWriter.js`) asks the local model for the
   cast (client, pirate leader, hideout, the client's reason), then for the
   briefing, the leader's taunt and the debrief, each in that speaker's voice.
   All text is saved with the offer. With the AI off, written lines are used.
3. **Accept.** `contractSite.js` creates a private dungeon instance that borrows
   a faction "Hideaway" template and replaces its contents: two waves, then the
   named leader with escorts, plus the leader's strongbox. The hideout is saved
   to your locations and listed as an anomaly in that system.
4. **Kill the leader.** EveJS marks the site's objective met; a listener in
   `contracts.js` records the contract as completed.
5. **Payout.** ISK is paid once under the idempotency key
   `rpg-contract:<characterID>:<contractID>:isk`. The debrief plays in the tab.
6. **Memory.** A one-line record of the outcome is kept (last six) and given to
   the writer for the next contract, so clients and grudges can carry over.

One contract can be open per pilot. Declining an offer costs nothing; abandoning
an accepted contract removes the site and is remembered.

## State and recovery

Table `rpgContracts`, one row per pilot: `sequence`, `contracts[]` (state
`offered → accepted → completed → paid`, or `declined` / `abandoned`), and
`memories[]`. Each step saves before it acts. At server start, an accepted
contract whose site is gone gets it rebuilt and a completed one is paid.

## Rules for changing this

- The model never chooses facts. Places, forces, pay and loot come from the
  director; the writer only receives them.
- Model output is clipped, stripped of markup and checked (the leader may not be
  named after the pilot or the client) before it is stored.
- Nothing in a fight waits on the model.

## Bridge calls (`evejsMod` service)

`GetContracts`, `RequestContract`, `AcceptContract(id)`, `AbandonContract(id)`.
Each returns `{contract, lastPaid, completedCount, error}`.

## Not done yet

Only the bounty shape exists. Standings and item rewards outside the strongbox,
recovery and raid shapes, recurring contacts, and Journal integration are next.
