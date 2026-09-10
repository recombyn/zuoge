# Real-time collaboration

Status of Figma-style multiplayer, and the concrete path to finish it.

## Done

| Layer | Where | State |
|---|---|---|
| **Collision-free identity** | `engine/src/lib.rs` (`make_id(site,counter)`) | Shipped. `id = (site<<22) \| counter`; site 0 == legacy numbering. Two live sessions with distinct sites can never mint the same id. See `collab-identity` memory. |
| **Presence transport** | `cloud/frontend/src/lib/collab.ts` | Shipped. Rebase SDK realtime channel: roster (who's here), site claiming against the roster, `saved` broadcast, and now `cursor` broadcast. |
| **Live cursors + selection** | `packages/editor/src/presence.ts` (`PresenceController`) + cloud wiring in `EditorView.tsx` | Shipped (editor side unit-tested + verified; network round-trip needs a two-client smoke test). Peer cursors render as a DOM overlay tracking pan/zoom. |

The editor exposes `editor.presence`: `setPeers(peers)` in, `onLocalPresence(cb)`
out, `reportLocalSelection(ids)` fed from the UI selection chokepoint. It is
transport-agnostic and inert until a host wires it.

## Not done — concurrent editing (the CRDT phase)

Today two people in a document see each other's cursors but still edit
independent copies reconciled only by the save-version check (a 409 with a
"someone else saved" prompt). True co-editing means each user's *operations*
stream to the others and merge without conflict. This is the multi-week part.

### Why the scene graph makes this hard

The engine state is a **tree** (nodes with parent/children + z-order), not a flat
map. The hard cases are all structural:

- **Z-order / sibling order** is a list; concurrent inserts and reorders need a
  list CRDT (fractional indexing or RGA-style) so two people reordering the same
  layer converge instead of clobbering.
- **Reparenting** can form cycles (A→B while B→A) that must be detected and one
  side rejected deterministically.
- **Delete vs edit** of the same node concurrently: tombstones, not removal, or a
  late-arriving edit resurrects a deleted node.
- **Property edits** (fill, transform) are last-writer-wins per field, keyed by a
  Lamport/hybrid-logical clock — the easy part.

### Recommended approach

1. **Semantic op log, not state diff.** The engine already funnels every change
   through ~160 mutation verbs in `wasm_scene.ts`. Emit a compact op per verb
   (`{siteId, lamport, kind, target, payload}`) rather than diffing serialized
   scenes. Ops are what broadcast and merge.
2. **Per-field LWW for properties**, **list-CRDT for children order**. Keep the
   two concerns separate; don't force one mechanism onto both.
3. **Fractional index keys for z-order** (store a rational/`f64` sort key per
   node instead of array position). An insert between two nodes picks a key
   between theirs; no renumbering, so concurrent inserts don't collide. This is a
   protocol/proto change (`DATA_MODEL.md`).
4. **Tombstones + HLC** for delete/edit races.
5. **Move-cycle guard** at apply time: reject a reparent whose new parent is a
   descendant, resolved by lamport order so both sides reject the same one.
6. **Per-user undo**: undo must skip peers' ops. The history already rewinds
   `next_id` while `id_high_water` floors allocation (see `collab-identity`); undo
   becomes "invert my ops only," which needs the op log from step 1.

### Suggested phasing

- **P1 — op emission + echo suppression.** Emit ops from the mutation verbs,
  broadcast them, apply remote ops to the engine. Ship behind a flag with
  property-edit LWW only (no structural merge yet) — already enough for two
  people styling different shapes live. Highest risk to single-user stability;
  gate carefully and keep the emit path a pure addition.
- **P2 — z-order fractional keys.** Proto/engine change; unblocks concurrent
  insert/reorder.
- **P3 — reparent cycle guard + delete tombstones.**
- **P4 — per-user undo** over the op log.
- **P5 — server op persistence + late-join replay** (load = snapshot + ops since).

### Testing reality

The presence/cursor layer needs a two-client smoke test (two browsers, one shared
cloud doc). The CRDT phases need a deterministic multi-replica test harness:
apply the same op sets in different orders to N in-memory engines and assert
byte-identical `serialize_scene()`. Build that harness first in P1 — convergence
is not observable by eye.
