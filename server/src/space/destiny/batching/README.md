# Destiny batching

The scene's one stamped list and its batches, as retail's server ticker keeps
them (`_ticker.py`, `_parkupdatebatcher.py`, `_actions.py`).

- `destinyHistory.js`: the list. Ballpark actions and updates are queued with
  the next tick's stamp, applied in call order in DoPreTick, routed after the
  grid bubble update (a ball's bubble, every bubble for a global ball, its
  owner for a cloaked one, one pilot for its own items), and taken as one
  batch per grid bubble and one per pilot in DoPostTick. Only a repeated
  Ballpark action collapses. Dogma events never enter it: they are collected
  per pilot and leave with its character batch or one OnMultiEvent.
- `parkUpdateBatcher.js`: the delivery plan: character singlecasts first,
  each flagged `waitForBubble` when its pilot also gets a bubble batch, then
  the bubble narrowcasts.
- `packagedAction.js`: a bubble's shared entered and left lists, marshalled
  once as PackagedActions.

All three are pure. The scene (`runtime/scene/destinyHistory.js`) supplies
the resolver and the pilots; `dispatch/batchDelivery.js` sends. See
[the retail tick](../../../../../doc/DESTINY_RETAIL_TICK.md).

## Carbon license notice

The PackagedAction and Park lane-planning behavior is adapted from
`carbonengine/destiny` v3.1.1.

MIT License

Copyright (c) 2026 CCP Games

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
