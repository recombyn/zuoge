# The `.Editor` file format

Version 1. This document is the normative description of the on-disk format —
enough to write an independent reader or writer without reading the editor's
source.

v1 is the first released format. Pre-release builds wrote other shapes, none of
which are readable and none of which need to be: there is no v0, and no
migrations exist.

## 1. Container

A `.Editor` file is a fixed 26-byte header followed by a payload. All integers
are **little-endian**.

| Offset | Size | Field                | Notes                                        |
| -----: | ---: | -------------------- | -------------------------------------------- |
|      0 |    6 | `magic`              | ASCII `Editor`                               |
|      6 |    2 | `container_version`  | u16. Currently `1`. Refuse if higher.        |
|      8 |    2 | `flags`              | u16 bitfield. Bit 0: payload is raw-deflate. |
|     10 |    4 | `min_reader_version` | u32. See §2.                                 |
|     14 |    4 | `payload_len`        | u32. Bytes of payload **as stored**.         |
|     18 |    4 | `uncompressed_len`   | u32. Payload size after inflate.             |
|     22 |    4 | `crc32`              | u32 over the **stored** payload bytes.       |
|     26 |    … | `payload`            | A `Document` protobuf message (§3).          |

Compression uses raw DEFLATE (RFC 1951, no zlib or gzip wrapper). A writer
should skip compression when the payload is under ~512 bytes or when the
deflated form is not smaller — already-compressed content such as embedded PNGs
can expand.

### Reading

Perform the checks in this order. The order matters: a future container layout
may move every field after offset 8, so parsing further would be reading noise,
and a length or CRC "mismatch" derived from noise sends the user chasing
corruption that isn't there.

1. `magic` absent → treat the whole file as a bare `Document` message (§5).
2. `container_version > 1` → refuse: written by a newer generation.
3. `min_reader_version > your FORMAT_VERSION` → refuse (§2).
4. Fewer than `payload_len` bytes after the header → refuse: truncated.
5. `crc32` mismatch → refuse: corrupt.
6. Inflate if bit 0 is set; refuse if the result is not `uncompressed_len` bytes.

An **empty file must be an error**, never an empty document. The empty byte
string is a valid protobuf message, so treating it as one turns an interrupted
save into a blank canvas that then overwrites the original.

Trailing bytes beyond `payload_len` are ignored.

## 2. `min_reader_version` — the compatibility contract

This is the single most important field, and it is **not** the writer's version.
It is *the oldest reader that can open this particular document without losing
anything*, computed from the features the document actually uses.

A reader whose own format version is lower **must refuse to open the file.**

The reason is that protobuf readers drop unknown fields. An old reader
physically cannot preserve what it does not understand, so if it opens a newer
document it will silently discard part of it and write the truncated version
back on the next save. Under last-writer-wins sync, that destroys the document
for every collaborator, not just locally. Refusing is the only way to protect
the data.

The floor is content-dependent so that the format stays permissive by default.
Everything in v1 — paths, vector networks, Live Paint, mesh gradients, multiple
strokes, embedded fonts, artboards, text — is readable by every build that will
ever exist, so an ordinary document reports a floor of `1` and stays openable
forever.

Only one thing raises the floor today: a `geometry` or `paint` whose `oneof` is
unset, which can only mean a variant written by a newer version. Such a file
reports a floor above this reader and is refused.

### What the floor cannot catch

`min_reader_version` detects **structural** change — a new field, a new `oneof`
variant, anything an older reader would decode as absent. It cannot detect a
**semantic** change to a field that already exists: same tag, same wire type,
new meaning. Such a file decodes cleanly and silently renders wrong.

This is not hypothetical. The decomposed transform's two skew angles were
redefined during development, from a sequential `Kx·Ky` product to a single
shear naming both edge directions. Identical bytes, different picture for any
node that skews on both axes. Nothing in this section would have flagged it.

There is no cheap general fix — detecting it would mean versioning the meaning
of every field, not just its presence. The rule instead is a process one:

> **Never redefine an existing field. Add a new one and leave the old.**

If a field's interpretation genuinely must change, it needs a `FORMAT_VERSION`
bump *and* a floor raise, so older readers refuse the file rather than draw it
incorrectly — the one case where the floor must rise even though nothing was
structurally added.

**When adding a feature**, raise the floor only if losing that feature would
visibly damage the artwork. Losing a mesh gradient changes a shape's colour, so
it counts. Losing the document title does not, and treating it as though it did
would lock every document to the newest build for no benefit.

## 3. Payload schema

The payload is a protobuf message. The full field-by-field schema is the prost
definition in [`src/proto.rs`](src/proto.rs); this section covers what a third
party needs to know beyond reading it.

Top-level `Document` fields of note:

- `format_version` (1) — informational. **Do not** use it for compatibility
  decisions; `min_reader_version` in the container is the contract.
- `nodes` (2) — flat list. Hierarchy is expressed by `children`, not nesting.
- `root_ids` (3) — top-level nodes, in paint order (first = bottom).
- `images` (9) — encoded raster bytes, referenced by `image_id`.
- `meta` (20) — uuid, created/modified timestamps (Unix epoch ms), authoring app
  version, title.
- `fonts` (21) — embedded faces, keyed by family + weight + italic.
- `swatches` (22), `text_paths` (23), `markers` (24), `guide_locks` (25) — typed
  replacements for the deprecated JSON-string fields at tags 16–19.

`geometry` and `paint` are real protobuf `oneof`s. An **unset** oneof means the
variant was written by a newer build; it is not a valid document in its own
right, and `min_reader_version` will already have caused such a file to be
refused.

### Reserved tags

`Document` tags **16–19** and `Path` tag **1** are reserved and must never be
reused. Pre-release builds stored the editor-owned collections as opaque JSON
strings at 16–19, and a flat point list at Path tag 1. Nothing reads them now,
but a stray file from that era would decode into the wrong fields if the numbers
were recycled.

## 4. Structural validity

A file can be well-formed protobuf and still describe an incoherent scene. A
reader must not assume any of the following and must not crash on their absence:

- `root_ids` and `children` may reference ids that are not present.
- The node graph may contain **cycles**, including self-references. A naive
  recursive walk over `children` will not terminate.
- A cycle may sit in a component **no root can reach**. Walking only from the
  roots therefore does not find every cycle.
- A node named in `root_ids` may *also* be claimed as someone's child. It cannot
  be both; `children` wins.
- A node's `parent` may disagree with the group listing it in `children`.
  `children` is authoritative.
- Nodes may be reachable from no root.
- The same id may be defined more than once.
- Coordinates may be NaN or infinite.
- `image_id` may reference bytes absent from `images`.

This implementation repairs all of these on load rather than rejecting the file
(see `src/validate.rs`), reports what it changed, and never deletes a node —
the top of each unreachable subtree is re-homed to the root and brings its
descendants with it. Repair is idempotent.

After repair the scene satisfies, for every document: every root exists and is
listed once; every child exists and is claimed by exactly one parent; `parent`
agrees with `children`; and every node is reachable from the roots exactly once
(which is "no cycles" and "nothing orphaned" together). These are asserted
against randomly generated malformed graphs in `format_properties.rs`, not just
against hand-picked examples — the two cases in the list above marked as easy to
miss were both found that way, after example-based tests had passed.

Coordinates are `f32` and clamped to ±1e6 (`MAX_COORD`). Beyond that, the gap
between representable values exceeds 1/16 unit and editing operations start to
silently no-op. Group nesting is bounded at 1024 deep.

## 5. There are no legacy files

The envelope is mandatory. Input without the `Editor` magic is rejected as
unparseable rather than guessed at — accepting headerless protobuf would mean
accepting the empty byte string as a valid empty document, which is exactly the
data-loss path §1 exists to close.

## 6. Undo snapshots are not this format

`serialize_snapshot` produces a `Snapshot` message (a `Document` plus the
selection) with **no envelope and no compression**. These are in-memory only.
They are produced on every mutation and compared byte-for-byte to coalesce undo
history, so compressing them would cost time on every edit and put a checksum in
the comparison path.

This is why nothing in serialization may invent a value. A timestamp or uuid
generated during `from_scene` would make two snapshots of an unchanged scene
differ and silently break undo coalescing. Document identity is assigned by the
editor and stored on the scene; the same requirement applies to any future field.

## 7. Changing the format

1. **Never renumber or reuse a tag.** Add new tags; mark old ones deprecated.
2. Decide whether the feature raises `min_reader_version` (§2) and add it to
   `required_reader_version` if so.
3. Add a round-trip test, and a case to the version-floor test.
4. Bump `FORMAT_VERSION`, and add the migration in `deserialize_from_proto` if
   the change is not purely additive. Bump `CONTAINER_VERSION` only if the
   *header* layout changes.
5. Confirm `serialize→deserialize→serialize` is still byte-exact — the undo
   fixed point in `format_tests.rs` will catch it if not.
