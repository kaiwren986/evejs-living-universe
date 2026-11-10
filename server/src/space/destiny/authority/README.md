# Destiny authority

Position and range for the scene. `scenePositionAuthority.js` registers each
ball and is the one place its position is read or set, as Evolve keeps it.
`sceneRangeDecision.js` answers range checks from the surface distance
between two balls. There is no separate session or delivery authority: the
scene's one stamped list (`batching/destinyHistory.js`) is the only queue.

There is no ship collision yet: ships are never sent massive (INTERIM in
`stream/ballEncoding.js`) until collisions are handled in Evolve.
