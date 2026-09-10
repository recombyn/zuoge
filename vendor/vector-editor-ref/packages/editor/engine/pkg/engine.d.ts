/* tslint:disable */
/* eslint-disable */

export class Engine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add a new artboard; returns its id. Auto-named "Artwork N".
     */
    add_artboard(x: number, y: number, w: number, h: number): number;
    add_ellipse(cx: number, cy: number, rx: number, ry: number): number;
    /**
     * Add a guide on the given axis ("x" = vertical, "y" = horizontal).
     * Returns the index of the new guide, or u32::MAX for a bad axis/value.
     */
    add_guide(axis: string, pos: number): number;
    add_image(x: number, y: number, w: number, h: number, image_id: number): number;
    /**
     * Add an edge between two vertices in a node's network. Returns the edge index.
     */
    add_network_edge(node_id: number, start: number, end: number): number;
    /**
     * Add a vertex to a node's network. Returns the new vertex index.
     */
    add_network_vertex(node_id: number, x: number, y: number): number;
    add_path(points_json: string): number;
    add_polygon(cx: number, cy: number, radius: number, sides: number): number;
    add_rect(x: number, y: number, w: number, h: number): number;
    /**
     * Batch-create rectangles from a JSON array of `[x, y, w, h]` tuples,
     * returning the new node ids in order. Unlike calling `add_rect` in a
     * loop, the spatial index is rebuilt once via `bulk_load` at the end
     * rather than per node — turning O(n²) bulk creation into O(n log n).
     * Used by bulk importers and the dev stress harness.
     */
    add_rects(rects_json: string): Uint32Array;
    add_star(cx: number, cy: number, outer_r: number, inner_r: number, num_points: number): number;
    /**
     * Add a text node.
     */
    add_text(x: number, y: number, content: string, font_size: number): number;
    bring_forward(id: number): void;
    bring_to_front(id: number): void;
    /**
     * Remove the paint from a logical edge.
     */
    clear_edge_paint(edge_id: number): void;
    /**
     * Clear a face's fill.
     */
    clear_face_fill(face_id: number): void;
    /**
     * Remove every guide on both axes.
     */
    clear_guides(): void;
    clear_live_paint_marks(): void;
    /**
     * Remove ALL Live Paint face fills and edge paints. Used by Expand once the
     * painted marks have been baked into real path shapes so they don't
     * double-render on top of the baked geometry.
     * Drop every mark belonging to ONE Live Paint group.
     *
     * Expand bakes a group's colours into real shapes and then has to remove the
     * marks it baked, or the same paint exists twice. It used to do that with
     * the document-wide clear below — so expanding one group erased the colours
     * of every OTHER group too. Copy a painted group, expand the copy, and the
     * original came back blank, which is what it looked like from the outside:
     * paint vanishing from something the user had not touched.
     *
     * Faces and logical edges carry their group, and a painted edge is found
     * through the shape it was painted on. A pending fill — one read from a file
     * and not yet placed — is attributed by its signature: if every shape that
     * bounded it belongs to this group, it was this group's.
     */
    clear_live_paint_marks_in_group(group: number): void;
    clear_node_dirty(id: number): void;
    clear_selection(): void;
    /**
     * Convert any geometry to a Path (editable points).
     * Rect → 4 corner points (closed). Ellipse → 4 bezier arcs (closed).
     * Returns true if a conversion happened.
     */
    convert_to_path(id: number): boolean;
    /**
     * Cut: lift whole subtrees out of the document and into the clipboard.
     *
     * As far as the document is concerned the nodes are gone — they don't
     * render, hit-test, list or save. But unlike `remove_node`, they still
     * exist, so `paste_clipboard` can put them back. That distinction is the
     * entire reason this exists: an id-keyed clipboard plus a destructive cut
     * leaves paste with nothing to copy from.
     *
     * Replaces any previous clipboard contents. Returns the number of roots cut.
     */
    cut_nodes(ids_json: string): number;
    /**
     * Dedup a selection: remove any node whose ancestor is also selected.
     */
    dedup_selection(ids_json: string): Uint32Array;
    /**
     * Take one node out of the selection, leaving the rest untouched.
     *
     * `select_node(id, true)` only ever adds — so shift-clicking a shape that
     * was already selected did nothing at all, when what it means everywhere
     * else is "remove this one".
     */
    deselect_node(id: number): void;
    /**
     * Deserialize scene from a `.Editor` file. Returns true on success.
     *
     * Prefer `load_document`, which reports *why* a load failed and what had
     * to be repaired. This boolean form is kept for callers that genuinely
     * only branch on success.
     */
    deserialize_proto(data: Uint8Array): boolean;
    /**
     * Deserialize scene from base64-encoded protobuf (from SVG metadata).
     * Returns true on success.
     */
    deserialize_proto_base64(b64: string): boolean;
    /**
     * Restore a scene from a protobuf snapshot (history/undo/drag-restore).
     * Returns false — and leaves the scene untouched — if the bytes don't
     * decode. A silent failure here breaks undo invisibly, so callers should
     * surface it.
     */
    deserialize_scene(data: Uint8Array): boolean;
    /**
     * Detect enclosed regions in a node's network (placeholder — uses simple cycle detection).
     */
    detect_node_regions(node_id: number): void;
    /**
     * Duplicate a node (and its entire subtree if a group) and return the new id.
     */
    duplicate_node(id: number): number;
    /**
     * Embed (or replace) a font face. Faces are keyed by family+weight+italic,
     * so re-embedding the same face overwrites rather than duplicating it.
     */
    embed_font(family: string, weight: number, italic: boolean, bytes: Uint8Array, source: string): void;
    /**
     * The raw bytes of embedded face `index`.
     *
     * Returned directly rather than base64 inside a JSON blob, matching
     * `get_image_bytes`. A face is 100–300 KB; base64 inflates it by a third,
     * and routing it through a JSON string means building that string in wasm,
     * copying it out, parsing it, and decoding it back to the bytes we already
     * had — several times the size of the payload, on every document open.
     */
    embedded_font_bytes(index: number): Uint8Array;
    /**
     * How many font faces this document embeds.
     */
    embedded_font_count(): number;
    /**
     * Family name of embedded face `index`.
     */
    embedded_font_family(index: number): string;
    /**
     * Whether embedded face `index` is italic.
     */
    embedded_font_italic(index: number): boolean;
    /**
     * CSS weight of embedded face `index` (400 regular, 700 bold).
     */
    embedded_font_weight(index: number): number;
    /**
     * World-space AABB of one face's outline as `[minX, minY, maxX, maxY]`,
     * or an empty vec if the id is unknown.
     *
     * Used to answer "what else is sitting on this region" — a shape outside
     * the Live Paint group contributes no segments, so it divides nothing, and
     * the only way to explain that to someone is to find it and name it.
     */
    face_bounds(face_id: number): Float32Array;
    /**
     * Bake the node's rotation/scale/skew into its geometry, resetting the
     * transform to translation-only. Rect/Ellipse nodes are first converted
     * to paths; groups push their linear transform into each child.
     */
    flatten_transform(id: number): boolean;
    /**
     * Flip a node horizontally: mirror across the vertical axis through the
     * center of its WORLD bounds. The mirror must be applied in world space
     * (pre-multiplied): a local-space mirror is a visual no-op for any
     * geometry that is symmetric in local space (rects, ellipses) no matter
     * how the node is skewed or rotated.
     */
    flip_node_horizontal(id: number): void;
    /**
     * Flip a node vertically (mirror across the horizontal center axis of
     * its world bounds).
     */
    flip_node_vertical(id: number): void;
    /**
     * All artboards as JSON: `[{id,name,x,y,w,h,background:{r,g,b,a}}, …]`.
     */
    get_artboards_json(): string;
    /**
     * Ids of every Boolean Group in the scene (JSON array). JS uses this after a
     * document load to recompute all cached outlines (they aren't serialized).
     */
    get_boolean_group_ids(): string;
    /**
     * A Boolean Group's outline bounds in its OWN local space, as
     * `[minX, minY, maxX, maxY]` — empty when it isn't a Boolean Group with a
     * usable cache. JS needs this for the oriented selection frame, which is
     * built in local space and then transformed (so it can sit rotated).
     */
    get_boolean_local_bounds(id: number): Float32Array;
    /**
     * The boolean op on a Group (0..3), or -1 if it isn't a Boolean Group.
     */
    get_boolean_op(id: number): number;
    get_document_app_version(): string;
    get_document_created_at(): number;
    get_document_height(): number;
    get_document_modified_at(): number;
    get_document_title(): string;
    get_document_uuid(): string;
    get_document_width(): number;
    /**
     * A logical edge's exact-bézier outline as JSON `[{x,y,cp1,cp2}]` (for the
     * hover highlight), or `[]` if the id is unknown.
     */
    get_edge_polyline(edge_id: number): string;
    /**
     * The gap-closing distance actually in force for a group — its own setting
     * if it has one, otherwise the document default. This is the number the UI
     * shows, so what the control reads is what the bucket obeys.
     */
    get_effective_gap_bridge_distance(id: number): number;
    /**
     * Get a face's exact-bézier outline as JSON `[{x,y,cp1:[x,y],cp2:[x,y]}]`
     * (closed subpath). Used for the hover highlight.
     */
    get_face_boundary(face_id: number): string;
    /**
     * A face's paint as JSON, or "" when it has none. The gradient handles
     * read through this: a face is not a node, so there is no style to query.
     */
    get_face_paint(face_id: number): string;
    /**
     * Get all filled faces as JSON for rendering. Each face carries both the
     * flattened `boundary` polygon (hit tests) and the exact-bézier `outline`
     * (anchor + handles) used to render/export true curves.
     */
    get_filled_faces(): string;
    /**
     * Get the current format version — the newest this build can write.
     */
    get_format_version(): number;
    /**
     * Get the current Live Paint gap-closing distance.
     */
    get_gap_bridge_distance(): number;
    get_guide_locks_json(): string;
    /**
     * Guides as JSON: `{"x":[..world x..],"y":[..world y..]}`.
     */
    get_guides_json(): string;
    /**
     * Encoded bytes for a registered image (for the renderer to decode).
     */
    get_image_bytes(image_id: number): Uint8Array;
    /**
     * MIME type for a registered image.
     */
    get_image_mime(image_id: number): string;
    /**
     * Whether an image node samples with nearest-neighbour.
     */
    get_image_pixelated(id: number): boolean;
    /**
     * Edges to bake on Expand: every logical edge of the ACTIVE group with an
     * effective stroke — the painted override if set, else the source shape's
     * own stroke. Expand deletes the originals, so this is what keeps the drawn
     * lines alive. JSON: `[{outline, color, width, cap, join}]`.
     */
    get_live_paint_expand_edges(): string;
    /**
     * Faces to bake on Expand: every non-outer face with an EFFECTIVE fill —
     * the painted override if set, else the fill of the topmost source shape
     * covering it (Illustrator absorbs source appearance). Faces with no fill
     * are omitted (discarded on expand). JSON: `[{outline, fill}]`.
     */
    get_live_paint_faces(): string;
    /**
     * The active Live Paint group node id, or -1 if none.
     */
    get_live_paint_group(): number;
    /**
     * Per-group Live Paint render data for SVG export, mirroring the in-app
     * compositing: every colored face (effective color, tagged with its owning
     * group) that draws UNDER the members' strokes, plus painted edges (on top).
     * JSON: `{"groups":[id,…],"faces":[{group,outline,fill}],"edges":[{group,outline,color,width}]}`.
     */
    get_live_paint_render_data(): string;
    get_markers_json(): string;
    /**
     * Get bounding box of a node in world coordinates: [minX, minY, maxX, maxY]
     */
    get_node_bounds(id: number): Float32Array;
    /**
     * Get a node's children IDs.
     */
    get_node_children(id: number): Uint32Array;
    /**
     * A node's effects as a serde-tagged JSON array.
     */
    get_node_effects(id: number): string;
    /**
     * A Live Paint group's own gap-closing distance, or -1 when it has none of
     * its own (it inherits the document default).
     */
    get_node_gap_bridge_distance(id: number): number;
    /**
     * Get a node's geometry as JSON.
     */
    get_node_geometry_json(id: number): string;
    get_node_is_mask(id: number): boolean;
    /**
     * Get a single node's full data as JSON. Used by UI panels.
     */
    get_node_json(id: number): string;
    get_node_live_paint(id: number): boolean;
    /**
     * Get a node's transform as a Vec<f32> (column-major, 9 elements).
     * Used by SVG export which needs the local transform, not the global one.
     */
    get_node_local_transform(id: number): Float32Array;
    /**
     * Get a node's locked flag.
     */
    get_node_locked(id: number): boolean;
    /**
     * Get a node's name.
     */
    get_node_name(id: number): string;
    /**
     * Get the per-node vector network as JSON.
     */
    get_node_network_json(id: number): string;
    /**
     * Get the parent node ID, or -1 if root.
     */
    get_node_parent(id: number): number;
    /**
     * Get a node's style as JSON.
     */
    get_node_style_json(id: number): string;
    get_node_transform_components(id: number): string;
    /**
     * Returns a pointer to a 9-element f32 array in Skia row-major format.
     * This transposes from the internal column-major storage.
     */
    get_node_transform_ptr(id: number): number;
    /**
     * Get the node type as u32: 0=Path, 1=Rect, 2=Ellipse, 3=Group, 4=Text, 5=Image
     */
    get_node_type(id: number): number | undefined;
    /**
     * Get a node's visible flag.
     */
    get_node_visible(id: number): boolean;
    /**
     * All painted logical edges as JSON for rendering. Carries the exact-bézier
     * `outline` (anchor + handles) and the flattened `polyline` (fallback).
     */
    get_painted_edges(): string;
    get_render_buffer(): number;
    get_render_buffer_size(): number;
    /**
     * Which (family, weight, italic) faces the document's text actually needs.
     * Returned as JSON so the editor can fetch and embed exactly these — there
     * is no point shipping a bold face for text that is never bold.
     */
    get_required_fonts_json(): string;
    /**
     * Get root node IDs.
     */
    get_root_nodes(): Uint32Array;
    get_scene_json(): string;
    get_selection(): Uint32Array;
    get_swatches_json(): string;
    get_text_paths_json(): string;
    /**
     * Returns visible node IDs in document draw order (back to front).
     * Uses the spatial index for fast culling, then sorts by scene tree order.
     */
    get_visible_nodes(min_x: number, min_y: number, max_x: number, max_y: number): Uint32Array;
    /**
     * Group selected nodes into a new Group node. Returns the group's id.
     * Deduplicates the selection (drops descendants of selected ancestors).
     * Places the group at the z-position of the topmost member in the common parent.
     */
    group_nodes(ids_json: string): number;
    /**
     * True when a cut is waiting to be pasted.
     */
    has_clipboard(): boolean;
    /**
     * Check whether a node's local transform has a non-identity linear part
     * (rotation, scale != 1, skew, or flip).
     */
    has_non_identity_linear(id: number): boolean;
    /**
     * The node a click at this world point lands on, topmost first.
     *
     * Takes `&mut self` for one reason: inside a Live Paint group the question
     * "is this point painted?" is answered by the FACES, and those have to be
     * current before it can be asked. Documents with no Live Paint group skip
     * that entirely and this is a pure read.
     */
    hit_test(x: number, y: number): number | undefined;
    /**
     * Group-aware hit test: finds the deepest leaf hit, then walks up the parent
     * chain to find the topmost Group ancestor that is a direct child of root
     * (or of a non-Group parent). Returns that group's ID, or the leaf ID if
     * no Group ancestor exists.
     */
    hit_test_grouped(x: number, y: number): number | undefined;
    /**
     * Mark the vector network as needing recomputation.
     */
    invalidate_vector_network(): void;
    /**
     * True when this node OR any ancestor is locked. The raw flag is not
     * enough for anything interactive: locking a group is meant to protect its
     * contents, so every "can the user grab this?" test has to read the chain.
     */
    is_locked_in_tree(id: number): boolean;
    is_node_dirty(id: number): boolean;
    /**
     * Check if the vector network is dirty.
     */
    is_vector_network_dirty(): boolean;
    /**
     * True when this node and every ancestor is visible — what the user can
     * actually see, as opposed to the node's own flag.
     */
    is_visible_in_tree(id: number): boolean;
    /**
     * Load a `.Editor` file, returning a JSON status object.
     *
     * On success: `{"ok":true,"repairs":{…},"repaired":bool,"summary":"…"}`.
     * On failure: `{"ok":false,"error":"too_new","detail":"…","requiredVersion":9,
     * "supportedVersion":8}`.
     *
     * Failure leaves the current scene **untouched**. That matters: the old
     * path assigned `self.scene` before it knew the load was sound, so a bad
     * file could half-replace a good document.
     */
    load_document(data: Uint8Array): string;
    /**
     * Base64 counterpart of `load_document`, for the payload embedded in an
     * exported SVG. Same JSON status contract.
     */
    load_document_base64(b64: string): string;
    move_node(id: number, dx: number, dy: number): void;
    /**
     * Move many nodes at once, each by its own delta.
     *
     * `moves_json` is `[{"id":1,"dx":2.0,"dy":3.0}, ...]`. Deltas are per-node
     * because a drag converts one world delta into a different local delta for
     * every node (each may sit under a differently-transformed parent).
     *
     * This exists for complexity, not tidiness. `move_node` finishes by
     * re-unioning every group ancestor's AABB, and a group's AABB is the union
     * of ALL its descendants — so moving N children of one group costs N × O(N).
     * A 4000-node drag frame measured 436ms that way. Here the translations are
     * applied first, then each distinct group ancestor is refreshed exactly
     * once, deepest first so a parent's union reads its children's fresh
     * entries. That makes a drag frame linear in the number of moved nodes.
     */
    move_nodes(moves_json: string): void;
    constructor();
    /**
     * Paste every clipboard root back into the document at the top level,
     * offset by (dx, dy). The clipboard is NOT consumed — pasting twice gives
     * two copies, the way it does everywhere else. Returns the new ids.
     */
    paste_clipboard(dx: number, dy: number): Uint32Array;
    /**
     * Drop embedded faces no text node references any more, so a document
     * doesn't accumulate megabytes of fonts from text that has been deleted.
     */
    prune_unused_fonts(): number;
    /**
     * Nearest paintable edge to a point (world units), or -1.
     */
    query_edge_at(x: number, y: number, tolerance: number): number;
    /**
     * Query which face contains the given point. Returns face ID or -1.
     */
    query_face_at(x: number, y: number): number;
    /**
     * Rebuild the planar graph from all visible paths.
     */
    rebuild_vector_network(): void;
    /**
     * Register encoded image bytes (PNG/JPEG/…), returning an image id.
     * Content-addressed: identical bytes reuse the same id (dedup).
     */
    register_image(bytes: Uint8Array, mime: string): number;
    /**
     * Remove an artboard. Returns true if one was removed.
     */
    remove_artboard(id: number): boolean;
    /**
     * Remove the guide at `index` on the given axis.
     */
    remove_guide(axis: string, index: number): boolean;
    /**
     * Remove a vertex (and its edges) from a node's network.
     */
    remove_network_vertex(node_id: number, vertex_idx: number): void;
    remove_node(id: number): void;
    /**
     * The render-buffer protocol version the engine emits. Exposed so JS and
     * tests can assert the freshly-built wasm matches what the reader expects.
     */
    static render_protocol_version(): number;
    /**
     * Move `node_id` to become a child of `new_parent` (or a root when `None`),
     * inserted at `index` among its new siblings. The node's global (visual)
     * position is preserved by recomputing its local transform. Returns false
     * if the move is invalid (missing node, non-group parent, or a cycle).
     *
     * `index` is a raw position in the parent's `children` vec (or `root_nodes`),
     * where 0 is the back-most (bottom of z-order). The layer panel renders in
     * reverse, so the UI is responsible for translating a visual drop position
     * into this bottom-up index.
     */
    reorder_node(node_id: number, new_parent: number | null | undefined, index: number): boolean;
    /**
     * Batch variant of [`reorder_node`]. Moves every node in `ids_json` (a JSON
     * array of ids, given in bottom-up z-order) so they become contiguous
     * siblings under `new_parent` (or roots when `None`), starting at `index`.
     * Their relative order is preserved. Nodes that fail validation (missing,
     * non-group parent, or a cycle) are skipped. Returns the number moved.
     */
    reorder_nodes(ids_json: string, new_parent: number | null | undefined, index: number): number;
    /**
     * Replace a node's geometry with a new path. Used for "Create Outlines".
     */
    replace_geometry_with_path(id: number, subpaths_json: string): boolean;
    /**
     * Resize a node's geometry to new width/height.
     */
    resize_node(id: number, new_w: number, new_h: number): void;
    /**
     * Resolve a Path node's per-vertex corner radii into an explicit rounded
     * outline and return it as JSON subpaths. Non-path geometry (or a path
     * with no rounding) yields the plain subpaths. Consumed by SVG export and
     * boolean ops so their output matches the rendered (rounded) shape.
     */
    resolve_subpaths_json(id: number): string;
    select_node(id: number, multi: boolean): void;
    send_backward(id: number): void;
    send_to_back(id: number): void;
    /**
     * Serialize scene to protobuf bytes (.vec file format).
     */
    serialize_proto(): Uint8Array;
    /**
     * Serialize scene to base64-encoded protobuf (for SVG embedding).
     */
    serialize_proto_base64(): string;
    serialize_scene(): Uint8Array;
    set_artboard_background(id: number, r: number, g: number, b: number, a_: number): boolean;
    /**
     * Resize/move an artboard. Rejects non-positive dimensions. Returns true on success.
     */
    set_artboard_bounds(id: number, x: number, y: number, w: number, h: number): boolean;
    set_artboard_name(id: number, name: string): boolean;
    /**
     * Push a recomputed outline (JSON `Vec<Subpath>`, in the group's LOCAL space)
     * into a Boolean Group's cache and clear its dirty flag. No-op otherwise.
     */
    set_bool_cache(id: number, subpaths_json: string): void;
    /**
     * Set (op = 0..3) or clear (op < 0) the boolean operation on a Group node,
     * making it a non-destructive Boolean Group. No-op on non-groups. Flags the
     * group so JS recomputes its cached outline on the next drain.
     */
    set_boolean_op(id: number, op: number): void;
    /**
     * Replace the document's identity block. `created_at_ms`/`modified_at_ms`
     * are Unix epoch milliseconds; 0 means unknown.
     */
    set_document_meta(uuid: string, created_at_ms: number, modified_at_ms: number, app_version: string, title: string): void;
    set_document_size(w: number, h: number): void;
    /**
     * Paint a logical edge with a stroke color/width. The paint is anchored in
     * the source path's local space so it follows the path when it moves.
     */
    set_edge_paint(edge_id: number, r: number, g: number, b: number, a: number, width: number): void;
    /**
     * Assign a solid fill colour to a face.
     */
    set_face_fill(face_id: number, r: number, g: number, b: number, a: number): void;
    /**
     * Assign any paint to a face — the gradient path. `paint_json` is the same
     * shape a node's `style.fills[0]` uses. Returns false if it doesn't parse,
     * rather than silently leaving the face unpainted.
     *
     * Gradient coordinates are WORLD space here: a face is a world-space
     * outline with no transform of its own, unlike a node's fill.
     */
    set_face_paint(face_id: number, paint_json: string): boolean;
    /**
     * Set the Live Paint gap-closing distance (world units). Open path ends
     * within this distance are bridged so the enclosed region is fillable.
     * 0 disables gap closing.
     */
    set_gap_bridge_distance(distance: number): void;
    /**
     * Set gap tolerance for the vector network.
     */
    set_gap_tolerance(tolerance: number): void;
    /**
     * Move an existing guide (live drag; no history).
     */
    set_guide(axis: string, index: number, pos: number): boolean;
    set_guide_locks_json(json: string): void;
    /**
     * Add a raster image node referencing a previously-registered image id.
     * Set whether an image node samples with nearest-neighbour when scaled.
     *
     * SVG spells this `image-rendering`; `optimizeSpeed`, `pixelated` and
     * `crisp-edges` all mean "do not smooth". Without it, magnifying pixel art
     * blurs it, which is both wrong per spec and the opposite of what anyone
     * drawing pixel art wants.
     */
    set_image_pixelated(id: number, on: boolean): boolean;
    /**
     * Scope Live Paint to a group's descendants (an Illustrator "Live Paint
     * Group"). Pass 0 to clear the scope (whole scene participates again).
     */
    set_live_paint_group(node_id: number): void;
    set_markers_json(json: string): void;
    /**
     * Update a vertex position and handles in a node's network.
     */
    set_network_vertex(node_id: number, vertex_idx: number, x: number, y: number, hin_x: number, hin_y: number, has_hin: boolean, hout_x: number, hout_y: number, has_hout: boolean): void;
    /**
     * Replace a node's effects from a JSON array of `Effect` (serde-tagged,
     * e.g. `[{"Blur":{"radius":6}}, {"DropShadow":{"dx":4,"dy":4,"blur":8,
     * "color":{"r":0,"g":0,"b":0,"a":0.5}}}]`).
     */
    set_node_effects(id: number, effects_json: string): void;
    /**
     * Set one Live Paint group's own gap-closing distance (world units), or
     * clear it with a negative value so the group goes back to inheriting the
     * document default. No-op on a node that isn't a Live Paint group.
     */
    set_node_gap_bridge_distance(id: number, distance: number): void;
    /**
     * Toggle whether a node masks the siblings painted above it. Marks the
     * parent dirty so the mask span is recomputed on the next render.
     */
    set_node_is_mask(id: number, is_mask: boolean): void;
    /**
     * Mark (or unmark) a Group node as a Live Paint group. No-op on non-groups.
     */
    set_node_live_paint(id: number, live_paint: boolean): void;
    set_node_locked(id: number, locked: boolean): void;
    /**
     * Set the mask coverage source: 0 = alpha, 1 = luminance (reserved).
     */
    set_node_mask_type(id: number, mask_type: number): void;
    set_node_name(id: number, name: string): void;
    /**
     * Set a node's absolute position (translation part of its local transform).
     */
    set_node_position(id: number, x: number, y: number): void;
    /**
     * Set fill color on a specific region of a node's network.
     */
    set_node_region_fill(node_id: number, region_idx: number, r: number, g: number, b: number, a: number): void;
    set_node_rotation(id: number, deg: number): void;
    /**
     * Set rotation while keeping a reference point fixed. `ax`/`ay` are the
     * normalized bounding-box anchor (0..1); (0.5,0.5) is the center and
     * matches `set_node_rotation`.
     */
    set_node_rotation_about(id: number, deg: number, ax: number, ay: number): void;
    /**
     * Scale factors of ~0 (or non-finite) are rejected: they collapse the
     * matrix and the geometry could never be recovered by scaling back up.
     */
    set_node_scale(id: number, sx: number, sy: number): void;
    /**
     * Set scale while keeping a reference point fixed (see `set_node_rotation_about`).
     */
    set_node_scale_about(id: number, sx: number, sy: number, ax: number, ay: number): void;
    /**
     * Each angle is clamped to ±89°: at 90° the corresponding edge has turned
     * a full quarter-turn and the shape degenerates to a line.
     *
     * The pair must also satisfy |x_deg + y_deg| < 90°, or the two edges are
     * parallel and the shape collapses. That case is not clamped — it is
     * rejected by the `is_valid` rollback in `set_components_about_center`,
     * leaving the node exactly as it was (same contract as a zero scale).
     */
    set_node_skew(id: number, x_deg: number, y_deg: number): void;
    set_node_style(id: number, style_json: string): void;
    set_node_transform_components(id: number, json: string): void;
    /**
     * Set a node's full local transform from a JSON array of 9 f32 values (column-major, matching `Mat3::from_cols_array`).
     */
    set_node_transform_matrix(id: number, transform_json: string): void;
    set_node_visible(id: number, visible: boolean): void;
    set_parent(child_id: number, parent_id?: number | null): boolean;
    /**
     * Set this engine's site before editing a shared document. Concurrent
     * editors must each be given a different one; sessions that never overlap
     * may reuse them freely.
     */
    set_site_id(site: number): void;
    set_swatches_json(json: string): void;
    /**
     * Update a text node's content and font size.
     */
    set_text_content(id: number, content: string, font_size: number): void;
    set_text_paths_json(json: string): void;
    /**
     * Update a text node's typography properties (font family, alignment, line height).
     */
    set_text_properties(id: number, font_family: string, text_align: number, line_height: number): void;
    /**
     * Update a text node's weight/style: font_weight (100–900), italic,
     * letter_spacing (local units).
     */
    set_text_style(id: number, font_weight: number, italic: boolean, letter_spacing: number): void;
    site_id(): number;
    /**
     * Drain and return the ids of Boolean Groups whose outline is stale, ordered
     * DEEPEST-FIRST so nested groups recompute before their parents. JSON array.
     */
    take_dirty_boolean_groups(): string;
    /**
     * Stamp the modification time, called by the editor just before a save.
     */
    touch_modified_at(now_ms: number): void;
    /**
     * Ungroup a group node, promoting its children to the group's parent level.
     * Children are inserted at the group's z-position, preserving their global positions.
     */
    ungroup_node(id: number): void;
    update_all_global_transforms(): void;
    update_all_spatial_indices(): void;
    update_path_points(id: number, subpaths_json: string): void;
    update_render_buffer(visible_ids: Uint32Array, sprite_roots: Uint32Array): void;
    /**
     * Cull + build in one call: run the R-tree viewport query internally and
     * build the render buffer directly, avoiding the ordered visible-id Vec,
     * its marshal across the wasm boundary, and the redundant second tree walk
     * that the separate `get_visible_nodes` + `update_render_buffer` pair does.
     * Used for ordinary frames; the renderer keeps the split path only for the
     * drag/snapshot/bake passes that need a JS-side id subset.
     */
    update_render_buffer_culled(min_x: number, min_y: number, max_x: number, max_y: number, sprite_roots: Uint32Array): void;
}

export class History {
    free(): void;
    [Symbol.dispose](): void;
    constructor(max_size: number);
    push_state(data: Uint8Array): void;
    redo(current_state: Uint8Array): Uint8Array | undefined;
    redo_len(): number;
    undo(current_state: Uint8Array): Uint8Array | undefined;
    /**
     * How many states are on each stack. The editor keeps a parallel stack of
     * the *mode* each state was captured in (which shape was being
     * node-edited, which group you had drilled into) so undo can put you back
     * where you were, and it trims that mirror against these lengths — this
     * struct silently drops the oldest state once `max_size` is exceeded, and
     * a mirror that missed the drop would hand every undo the wrong mode.
     */
    undo_len(): number;
}

export enum NodeType {
    Path = 0,
    Rect = 1,
    Ellipse = 2,
    Group = 3,
    Text = 4,
    Image = 5,
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly __wbg_history_free: (a: number, b: number) => void;
    readonly engine_add_artboard: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly engine_add_ellipse: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly engine_add_guide: (a: number, b: number, c: number, d: number) => number;
    readonly engine_add_image: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly engine_add_network_edge: (a: number, b: number, c: number, d: number) => number;
    readonly engine_add_network_vertex: (a: number, b: number, c: number, d: number) => number;
    readonly engine_add_path: (a: number, b: number, c: number) => number;
    readonly engine_add_polygon: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly engine_add_rect: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly engine_add_rects: (a: number, b: number, c: number) => [number, number];
    readonly engine_add_star: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly engine_add_text: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly engine_bring_forward: (a: number, b: number) => void;
    readonly engine_bring_to_front: (a: number, b: number) => void;
    readonly engine_clear_edge_paint: (a: number, b: number) => void;
    readonly engine_clear_face_fill: (a: number, b: number) => void;
    readonly engine_clear_guides: (a: number) => void;
    readonly engine_clear_live_paint_marks: (a: number) => void;
    readonly engine_clear_live_paint_marks_in_group: (a: number, b: number) => void;
    readonly engine_clear_node_dirty: (a: number, b: number) => void;
    readonly engine_clear_selection: (a: number) => void;
    readonly engine_convert_to_path: (a: number, b: number) => number;
    readonly engine_cut_nodes: (a: number, b: number, c: number) => number;
    readonly engine_dedup_selection: (a: number, b: number, c: number) => [number, number];
    readonly engine_deselect_node: (a: number, b: number) => void;
    readonly engine_deserialize_proto: (a: number, b: number, c: number) => number;
    readonly engine_deserialize_proto_base64: (a: number, b: number, c: number) => number;
    readonly engine_deserialize_scene: (a: number, b: number, c: number) => number;
    readonly engine_detect_node_regions: (a: number, b: number) => void;
    readonly engine_duplicate_node: (a: number, b: number) => number;
    readonly engine_embed_font: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly engine_embedded_font_bytes: (a: number, b: number) => [number, number];
    readonly engine_embedded_font_count: (a: number) => number;
    readonly engine_embedded_font_family: (a: number, b: number) => [number, number];
    readonly engine_embedded_font_italic: (a: number, b: number) => number;
    readonly engine_embedded_font_weight: (a: number, b: number) => number;
    readonly engine_face_bounds: (a: number, b: number) => [number, number];
    readonly engine_flatten_transform: (a: number, b: number) => number;
    readonly engine_flip_node_horizontal: (a: number, b: number) => void;
    readonly engine_flip_node_vertical: (a: number, b: number) => void;
    readonly engine_get_artboards_json: (a: number) => [number, number];
    readonly engine_get_boolean_group_ids: (a: number) => [number, number];
    readonly engine_get_boolean_local_bounds: (a: number, b: number) => [number, number];
    readonly engine_get_boolean_op: (a: number, b: number) => number;
    readonly engine_get_document_app_version: (a: number) => [number, number];
    readonly engine_get_document_created_at: (a: number) => number;
    readonly engine_get_document_height: (a: number) => number;
    readonly engine_get_document_modified_at: (a: number) => number;
    readonly engine_get_document_title: (a: number) => [number, number];
    readonly engine_get_document_uuid: (a: number) => [number, number];
    readonly engine_get_document_width: (a: number) => number;
    readonly engine_get_edge_polyline: (a: number, b: number) => [number, number];
    readonly engine_get_effective_gap_bridge_distance: (a: number, b: number) => number;
    readonly engine_get_face_boundary: (a: number, b: number) => [number, number];
    readonly engine_get_face_paint: (a: number, b: number) => [number, number];
    readonly engine_get_filled_faces: (a: number) => [number, number];
    readonly engine_get_format_version: (a: number) => number;
    readonly engine_get_gap_bridge_distance: (a: number) => number;
    readonly engine_get_guide_locks_json: (a: number) => [number, number];
    readonly engine_get_guides_json: (a: number) => [number, number];
    readonly engine_get_image_bytes: (a: number, b: number) => [number, number];
    readonly engine_get_image_mime: (a: number, b: number) => [number, number];
    readonly engine_get_image_pixelated: (a: number, b: number) => number;
    readonly engine_get_live_paint_expand_edges: (a: number) => [number, number];
    readonly engine_get_live_paint_faces: (a: number) => [number, number];
    readonly engine_get_live_paint_group: (a: number) => number;
    readonly engine_get_live_paint_render_data: (a: number) => [number, number];
    readonly engine_get_markers_json: (a: number) => [number, number];
    readonly engine_get_node_bounds: (a: number, b: number) => [number, number];
    readonly engine_get_node_children: (a: number, b: number) => [number, number];
    readonly engine_get_node_effects: (a: number, b: number) => [number, number];
    readonly engine_get_node_gap_bridge_distance: (a: number, b: number) => number;
    readonly engine_get_node_geometry_json: (a: number, b: number) => [number, number];
    readonly engine_get_node_is_mask: (a: number, b: number) => number;
    readonly engine_get_node_json: (a: number, b: number) => [number, number];
    readonly engine_get_node_live_paint: (a: number, b: number) => number;
    readonly engine_get_node_local_transform: (a: number, b: number) => [number, number];
    readonly engine_get_node_locked: (a: number, b: number) => number;
    readonly engine_get_node_name: (a: number, b: number) => [number, number];
    readonly engine_get_node_network_json: (a: number, b: number) => [number, number];
    readonly engine_get_node_parent: (a: number, b: number) => number;
    readonly engine_get_node_style_json: (a: number, b: number) => [number, number];
    readonly engine_get_node_transform_components: (a: number, b: number) => [number, number];
    readonly engine_get_node_transform_ptr: (a: number, b: number) => number;
    readonly engine_get_node_type: (a: number, b: number) => number;
    readonly engine_get_node_visible: (a: number, b: number) => number;
    readonly engine_get_painted_edges: (a: number) => [number, number];
    readonly engine_get_render_buffer: (a: number) => number;
    readonly engine_get_render_buffer_size: (a: number) => number;
    readonly engine_get_required_fonts_json: (a: number) => [number, number];
    readonly engine_get_root_nodes: (a: number) => [number, number];
    readonly engine_get_scene_json: (a: number) => [number, number];
    readonly engine_get_selection: (a: number) => [number, number];
    readonly engine_get_swatches_json: (a: number) => [number, number];
    readonly engine_get_text_paths_json: (a: number) => [number, number];
    readonly engine_get_visible_nodes: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly engine_group_nodes: (a: number, b: number, c: number) => number;
    readonly engine_has_clipboard: (a: number) => number;
    readonly engine_has_non_identity_linear: (a: number, b: number) => number;
    readonly engine_hit_test: (a: number, b: number, c: number) => number;
    readonly engine_hit_test_grouped: (a: number, b: number, c: number) => number;
    readonly engine_invalidate_vector_network: (a: number) => void;
    readonly engine_is_locked_in_tree: (a: number, b: number) => number;
    readonly engine_is_node_dirty: (a: number, b: number) => number;
    readonly engine_is_vector_network_dirty: (a: number) => number;
    readonly engine_is_visible_in_tree: (a: number, b: number) => number;
    readonly engine_load_document: (a: number, b: number, c: number) => [number, number];
    readonly engine_load_document_base64: (a: number, b: number, c: number) => [number, number];
    readonly engine_move_node: (a: number, b: number, c: number, d: number) => void;
    readonly engine_move_nodes: (a: number, b: number, c: number) => void;
    readonly engine_new: () => number;
    readonly engine_paste_clipboard: (a: number, b: number, c: number) => [number, number];
    readonly engine_prune_unused_fonts: (a: number) => number;
    readonly engine_query_edge_at: (a: number, b: number, c: number, d: number) => number;
    readonly engine_query_face_at: (a: number, b: number, c: number) => number;
    readonly engine_rebuild_vector_network: (a: number) => void;
    readonly engine_register_image: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly engine_remove_artboard: (a: number, b: number) => number;
    readonly engine_remove_guide: (a: number, b: number, c: number, d: number) => number;
    readonly engine_remove_network_vertex: (a: number, b: number, c: number) => void;
    readonly engine_remove_node: (a: number, b: number) => void;
    readonly engine_render_protocol_version: () => number;
    readonly engine_reorder_node: (a: number, b: number, c: number, d: number) => number;
    readonly engine_reorder_nodes: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly engine_replace_geometry_with_path: (a: number, b: number, c: number, d: number) => number;
    readonly engine_resize_node: (a: number, b: number, c: number, d: number) => void;
    readonly engine_resolve_subpaths_json: (a: number, b: number) => [number, number];
    readonly engine_select_node: (a: number, b: number, c: number) => void;
    readonly engine_send_backward: (a: number, b: number) => void;
    readonly engine_send_to_back: (a: number, b: number) => void;
    readonly engine_serialize_proto: (a: number) => [number, number];
    readonly engine_serialize_proto_base64: (a: number) => [number, number];
    readonly engine_serialize_scene: (a: number) => [number, number];
    readonly engine_set_artboard_background: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly engine_set_artboard_bounds: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly engine_set_artboard_name: (a: number, b: number, c: number, d: number) => number;
    readonly engine_set_bool_cache: (a: number, b: number, c: number, d: number) => void;
    readonly engine_set_boolean_op: (a: number, b: number, c: number) => void;
    readonly engine_set_document_meta: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly engine_set_document_size: (a: number, b: number, c: number) => void;
    readonly engine_set_edge_paint: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly engine_set_face_fill: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly engine_set_face_paint: (a: number, b: number, c: number, d: number) => number;
    readonly engine_set_gap_bridge_distance: (a: number, b: number) => void;
    readonly engine_set_gap_tolerance: (a: number, b: number) => void;
    readonly engine_set_guide: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly engine_set_guide_locks_json: (a: number, b: number, c: number) => void;
    readonly engine_set_image_pixelated: (a: number, b: number, c: number) => number;
    readonly engine_set_live_paint_group: (a: number, b: number) => void;
    readonly engine_set_markers_json: (a: number, b: number, c: number) => void;
    readonly engine_set_network_vertex: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly engine_set_node_effects: (a: number, b: number, c: number, d: number) => void;
    readonly engine_set_node_gap_bridge_distance: (a: number, b: number, c: number) => void;
    readonly engine_set_node_is_mask: (a: number, b: number, c: number) => void;
    readonly engine_set_node_live_paint: (a: number, b: number, c: number) => void;
    readonly engine_set_node_locked: (a: number, b: number, c: number) => void;
    readonly engine_set_node_mask_type: (a: number, b: number, c: number) => void;
    readonly engine_set_node_name: (a: number, b: number, c: number, d: number) => void;
    readonly engine_set_node_position: (a: number, b: number, c: number, d: number) => void;
    readonly engine_set_node_region_fill: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly engine_set_node_rotation: (a: number, b: number, c: number) => void;
    readonly engine_set_node_rotation_about: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly engine_set_node_scale: (a: number, b: number, c: number, d: number) => void;
    readonly engine_set_node_scale_about: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly engine_set_node_skew: (a: number, b: number, c: number, d: number) => void;
    readonly engine_set_node_style: (a: number, b: number, c: number, d: number) => void;
    readonly engine_set_node_transform_components: (a: number, b: number, c: number, d: number) => void;
    readonly engine_set_node_transform_matrix: (a: number, b: number, c: number, d: number) => void;
    readonly engine_set_node_visible: (a: number, b: number, c: number) => void;
    readonly engine_set_parent: (a: number, b: number, c: number) => number;
    readonly engine_set_site_id: (a: number, b: number) => void;
    readonly engine_set_swatches_json: (a: number, b: number, c: number) => void;
    readonly engine_set_text_content: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly engine_set_text_paths_json: (a: number, b: number, c: number) => void;
    readonly engine_set_text_properties: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly engine_set_text_style: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly engine_site_id: (a: number) => number;
    readonly engine_take_dirty_boolean_groups: (a: number) => [number, number];
    readonly engine_touch_modified_at: (a: number, b: number) => void;
    readonly engine_ungroup_node: (a: number, b: number) => void;
    readonly engine_update_all_global_transforms: (a: number) => void;
    readonly engine_update_all_spatial_indices: (a: number) => void;
    readonly engine_update_path_points: (a: number, b: number, c: number, d: number) => void;
    readonly engine_update_render_buffer: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly engine_update_render_buffer_culled: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly history_new: (a: number) => number;
    readonly history_push_state: (a: number, b: number, c: number) => void;
    readonly history_redo: (a: number, b: number, c: number) => [number, number];
    readonly history_redo_len: (a: number) => number;
    readonly history_undo: (a: number, b: number, c: number) => [number, number];
    readonly history_undo_len: (a: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
