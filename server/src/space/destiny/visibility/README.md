# Destiny visibility

Visibility is Grid bubble membership.

`gridBubbles.js` is the Grid bubble park: retail's label on the level-0 partition boxes (own box's
label, else the first labelled touching box in x, y, z loop order, else a fresh id), the +1/-1 marks a
re-box, an AddBall or a RemoveBall writes, and `additionsAndDeletions`, which turns the marks into one
shared entered and left list per Grid bubble with an Observer, or a diff for an Observer whose own
bubble changed, then commits them. It is pure: the scene (`space/runtime/scene/spatialTopology.js`
and `scene/visibility.js`) owns the one park of each Solar system and calls it.

No per-Observer visible set exists: what a session's client knows is the bubble it was last told about
and the marks that committed in it.

## Carbon license notice

The Grid bubble label and the additions-and-deletions split are adapted from `carbonengine/destiny`
v2.1.1 (`Ballpark.cpp` InsertInBoxes, AddToBubble and CopyBubbles; `Box.cpp` NearbyBubbles;
`Thunkers.cpp` PyAdditionsAndDeletions).

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
