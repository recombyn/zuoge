/* @ts-self-types="./engine.d.ts" */

export class Engine {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_engine_free(ptr, 0);
    }
    /**
     * Add a new artboard; returns its id. Auto-named "Artwork N".
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     * @returns {number}
     */
    add_artboard(x, y, w, h) {
        const ret = wasm.engine_add_artboard(this.__wbg_ptr, x, y, w, h);
        return ret >>> 0;
    }
    /**
     * @param {number} cx
     * @param {number} cy
     * @param {number} rx
     * @param {number} ry
     * @returns {number}
     */
    add_ellipse(cx, cy, rx, ry) {
        const ret = wasm.engine_add_ellipse(this.__wbg_ptr, cx, cy, rx, ry);
        return ret >>> 0;
    }
    /**
     * Add a guide on the given axis ("x" = vertical, "y" = horizontal).
     * Returns the index of the new guide, or u32::MAX for a bad axis/value.
     * @param {string} axis
     * @param {number} pos
     * @returns {number}
     */
    add_guide(axis, pos) {
        const ptr0 = passStringToWasm0(axis, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_add_guide(this.__wbg_ptr, ptr0, len0, pos);
        return ret >>> 0;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     * @param {number} image_id
     * @returns {number}
     */
    add_image(x, y, w, h, image_id) {
        const ret = wasm.engine_add_image(this.__wbg_ptr, x, y, w, h, image_id);
        return ret >>> 0;
    }
    /**
     * Add an edge between two vertices in a node's network. Returns the edge index.
     * @param {number} node_id
     * @param {number} start
     * @param {number} end
     * @returns {number}
     */
    add_network_edge(node_id, start, end) {
        const ret = wasm.engine_add_network_edge(this.__wbg_ptr, node_id, start, end);
        return ret;
    }
    /**
     * Add a vertex to a node's network. Returns the new vertex index.
     * @param {number} node_id
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    add_network_vertex(node_id, x, y) {
        const ret = wasm.engine_add_network_vertex(this.__wbg_ptr, node_id, x, y);
        return ret;
    }
    /**
     * @param {string} points_json
     * @returns {number}
     */
    add_path(points_json) {
        const ptr0 = passStringToWasm0(points_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_add_path(this.__wbg_ptr, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * @param {number} cx
     * @param {number} cy
     * @param {number} radius
     * @param {number} sides
     * @returns {number}
     */
    add_polygon(cx, cy, radius, sides) {
        const ret = wasm.engine_add_polygon(this.__wbg_ptr, cx, cy, radius, sides);
        return ret >>> 0;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     * @returns {number}
     */
    add_rect(x, y, w, h) {
        const ret = wasm.engine_add_rect(this.__wbg_ptr, x, y, w, h);
        return ret >>> 0;
    }
    /**
     * Batch-create rectangles from a JSON array of `[x, y, w, h]` tuples,
     * returning the new node ids in order. Unlike calling `add_rect` in a
     * loop, the spatial index is rebuilt once via `bulk_load` at the end
     * rather than per node — turning O(n²) bulk creation into O(n log n).
     * Used by bulk importers and the dev stress harness.
     * @param {string} rects_json
     * @returns {Uint32Array}
     */
    add_rects(rects_json) {
        const ptr0 = passStringToWasm0(rects_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_add_rects(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * @param {number} cx
     * @param {number} cy
     * @param {number} outer_r
     * @param {number} inner_r
     * @param {number} num_points
     * @returns {number}
     */
    add_star(cx, cy, outer_r, inner_r, num_points) {
        const ret = wasm.engine_add_star(this.__wbg_ptr, cx, cy, outer_r, inner_r, num_points);
        return ret >>> 0;
    }
    /**
     * Add a text node.
     * @param {number} x
     * @param {number} y
     * @param {string} content
     * @param {number} font_size
     * @returns {number}
     */
    add_text(x, y, content, font_size) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_add_text(this.__wbg_ptr, x, y, ptr0, len0, font_size);
        return ret >>> 0;
    }
    /**
     * @param {number} id
     */
    bring_forward(id) {
        wasm.engine_bring_forward(this.__wbg_ptr, id);
    }
    /**
     * @param {number} id
     */
    bring_to_front(id) {
        wasm.engine_bring_to_front(this.__wbg_ptr, id);
    }
    /**
     * Remove the paint from a logical edge.
     * @param {number} edge_id
     */
    clear_edge_paint(edge_id) {
        wasm.engine_clear_edge_paint(this.__wbg_ptr, edge_id);
    }
    /**
     * Clear a face's fill.
     * @param {number} face_id
     */
    clear_face_fill(face_id) {
        wasm.engine_clear_face_fill(this.__wbg_ptr, face_id);
    }
    /**
     * Remove every guide on both axes.
     */
    clear_guides() {
        wasm.engine_clear_guides(this.__wbg_ptr);
    }
    clear_live_paint_marks() {
        wasm.engine_clear_live_paint_marks(this.__wbg_ptr);
    }
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
     * @param {number} group
     */
    clear_live_paint_marks_in_group(group) {
        wasm.engine_clear_live_paint_marks_in_group(this.__wbg_ptr, group);
    }
    /**
     * @param {number} id
     */
    clear_node_dirty(id) {
        wasm.engine_clear_node_dirty(this.__wbg_ptr, id);
    }
    clear_selection() {
        wasm.engine_clear_selection(this.__wbg_ptr);
    }
    /**
     * Convert any geometry to a Path (editable points).
     * Rect → 4 corner points (closed). Ellipse → 4 bezier arcs (closed).
     * Returns true if a conversion happened.
     * @param {number} id
     * @returns {boolean}
     */
    convert_to_path(id) {
        const ret = wasm.engine_convert_to_path(this.__wbg_ptr, id);
        return ret !== 0;
    }
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
     * @param {string} ids_json
     * @returns {number}
     */
    cut_nodes(ids_json) {
        const ptr0 = passStringToWasm0(ids_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_cut_nodes(this.__wbg_ptr, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * Dedup a selection: remove any node whose ancestor is also selected.
     * @param {string} ids_json
     * @returns {Uint32Array}
     */
    dedup_selection(ids_json) {
        const ptr0 = passStringToWasm0(ids_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_dedup_selection(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * Take one node out of the selection, leaving the rest untouched.
     *
     * `select_node(id, true)` only ever adds — so shift-clicking a shape that
     * was already selected did nothing at all, when what it means everywhere
     * else is "remove this one".
     * @param {number} id
     */
    deselect_node(id) {
        wasm.engine_deselect_node(this.__wbg_ptr, id);
    }
    /**
     * Deserialize scene from a `.Editor` file. Returns true on success.
     *
     * Prefer `load_document`, which reports *why* a load failed and what had
     * to be repaired. This boolean form is kept for callers that genuinely
     * only branch on success.
     * @param {Uint8Array} data
     * @returns {boolean}
     */
    deserialize_proto(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_deserialize_proto(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Deserialize scene from base64-encoded protobuf (from SVG metadata).
     * Returns true on success.
     * @param {string} b64
     * @returns {boolean}
     */
    deserialize_proto_base64(b64) {
        const ptr0 = passStringToWasm0(b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_deserialize_proto_base64(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Restore a scene from a protobuf snapshot (history/undo/drag-restore).
     * Returns false — and leaves the scene untouched — if the bytes don't
     * decode. A silent failure here breaks undo invisibly, so callers should
     * surface it.
     * @param {Uint8Array} data
     * @returns {boolean}
     */
    deserialize_scene(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_deserialize_scene(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Detect enclosed regions in a node's network (placeholder — uses simple cycle detection).
     * @param {number} node_id
     */
    detect_node_regions(node_id) {
        wasm.engine_detect_node_regions(this.__wbg_ptr, node_id);
    }
    /**
     * Duplicate a node (and its entire subtree if a group) and return the new id.
     * @param {number} id
     * @returns {number}
     */
    duplicate_node(id) {
        const ret = wasm.engine_duplicate_node(this.__wbg_ptr, id);
        return ret >>> 0;
    }
    /**
     * Embed (or replace) a font face. Faces are keyed by family+weight+italic,
     * so re-embedding the same face overwrites rather than duplicating it.
     * @param {string} family
     * @param {number} weight
     * @param {boolean} italic
     * @param {Uint8Array} bytes
     * @param {string} source
     */
    embed_font(family, weight, italic, bytes, source) {
        const ptr0 = passStringToWasm0(family, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        wasm.engine_embed_font(this.__wbg_ptr, ptr0, len0, weight, italic, ptr1, len1, ptr2, len2);
    }
    /**
     * The raw bytes of embedded face `index`.
     *
     * Returned directly rather than base64 inside a JSON blob, matching
     * `get_image_bytes`. A face is 100–300 KB; base64 inflates it by a third,
     * and routing it through a JSON string means building that string in wasm,
     * copying it out, parsing it, and decoding it back to the bytes we already
     * had — several times the size of the payload, on every document open.
     * @param {number} index
     * @returns {Uint8Array}
     */
    embedded_font_bytes(index) {
        const ret = wasm.engine_embedded_font_bytes(this.__wbg_ptr, index);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * How many font faces this document embeds.
     * @returns {number}
     */
    embedded_font_count() {
        const ret = wasm.engine_embedded_font_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Family name of embedded face `index`.
     * @param {number} index
     * @returns {string}
     */
    embedded_font_family(index) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_embedded_font_family(this.__wbg_ptr, index);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Whether embedded face `index` is italic.
     * @param {number} index
     * @returns {boolean}
     */
    embedded_font_italic(index) {
        const ret = wasm.engine_embedded_font_italic(this.__wbg_ptr, index);
        return ret !== 0;
    }
    /**
     * CSS weight of embedded face `index` (400 regular, 700 bold).
     * @param {number} index
     * @returns {number}
     */
    embedded_font_weight(index) {
        const ret = wasm.engine_embedded_font_weight(this.__wbg_ptr, index);
        return ret >>> 0;
    }
    /**
     * World-space AABB of one face's outline as `[minX, minY, maxX, maxY]`,
     * or an empty vec if the id is unknown.
     *
     * Used to answer "what else is sitting on this region" — a shape outside
     * the Live Paint group contributes no segments, so it divides nothing, and
     * the only way to explain that to someone is to find it and name it.
     * @param {number} face_id
     * @returns {Float32Array}
     */
    face_bounds(face_id) {
        const ret = wasm.engine_face_bounds(this.__wbg_ptr, face_id);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Bake the node's rotation/scale/skew into its geometry, resetting the
     * transform to translation-only. Rect/Ellipse nodes are first converted
     * to paths; groups push their linear transform into each child.
     * @param {number} id
     * @returns {boolean}
     */
    flatten_transform(id) {
        const ret = wasm.engine_flatten_transform(this.__wbg_ptr, id);
        return ret !== 0;
    }
    /**
     * Flip a node horizontally: mirror across the vertical axis through the
     * center of its WORLD bounds. The mirror must be applied in world space
     * (pre-multiplied): a local-space mirror is a visual no-op for any
     * geometry that is symmetric in local space (rects, ellipses) no matter
     * how the node is skewed or rotated.
     * @param {number} id
     */
    flip_node_horizontal(id) {
        wasm.engine_flip_node_horizontal(this.__wbg_ptr, id);
    }
    /**
     * Flip a node vertically (mirror across the horizontal center axis of
     * its world bounds).
     * @param {number} id
     */
    flip_node_vertical(id) {
        wasm.engine_flip_node_vertical(this.__wbg_ptr, id);
    }
    /**
     * All artboards as JSON: `[{id,name,x,y,w,h,background:{r,g,b,a}}, …]`.
     * @returns {string}
     */
    get_artboards_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_artboards_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Ids of every Boolean Group in the scene (JSON array). JS uses this after a
     * document load to recompute all cached outlines (they aren't serialized).
     * @returns {string}
     */
    get_boolean_group_ids() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_boolean_group_ids(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * A Boolean Group's outline bounds in its OWN local space, as
     * `[minX, minY, maxX, maxY]` — empty when it isn't a Boolean Group with a
     * usable cache. JS needs this for the oriented selection frame, which is
     * built in local space and then transformed (so it can sit rotated).
     * @param {number} id
     * @returns {Float32Array}
     */
    get_boolean_local_bounds(id) {
        const ret = wasm.engine_get_boolean_local_bounds(this.__wbg_ptr, id);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The boolean op on a Group (0..3), or -1 if it isn't a Boolean Group.
     * @param {number} id
     * @returns {number}
     */
    get_boolean_op(id) {
        const ret = wasm.engine_get_boolean_op(this.__wbg_ptr, id);
        return ret;
    }
    /**
     * @returns {string}
     */
    get_document_app_version() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_document_app_version(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get_document_created_at() {
        const ret = wasm.engine_get_document_created_at(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get_document_height() {
        const ret = wasm.engine_get_document_height(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get_document_modified_at() {
        const ret = wasm.engine_get_document_modified_at(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get_document_title() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_document_title(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get_document_uuid() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_document_uuid(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get_document_width() {
        const ret = wasm.engine_get_document_width(this.__wbg_ptr);
        return ret;
    }
    /**
     * A logical edge's exact-bézier outline as JSON `[{x,y,cp1,cp2}]` (for the
     * hover highlight), or `[]` if the id is unknown.
     * @param {number} edge_id
     * @returns {string}
     */
    get_edge_polyline(edge_id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_edge_polyline(this.__wbg_ptr, edge_id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The gap-closing distance actually in force for a group — its own setting
     * if it has one, otherwise the document default. This is the number the UI
     * shows, so what the control reads is what the bucket obeys.
     * @param {number} id
     * @returns {number}
     */
    get_effective_gap_bridge_distance(id) {
        const ret = wasm.engine_get_effective_gap_bridge_distance(this.__wbg_ptr, id);
        return ret;
    }
    /**
     * Get a face's exact-bézier outline as JSON `[{x,y,cp1:[x,y],cp2:[x,y]}]`
     * (closed subpath). Used for the hover highlight.
     * @param {number} face_id
     * @returns {string}
     */
    get_face_boundary(face_id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_face_boundary(this.__wbg_ptr, face_id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * A face's paint as JSON, or "" when it has none. The gradient handles
     * read through this: a face is not a node, so there is no style to query.
     * @param {number} face_id
     * @returns {string}
     */
    get_face_paint(face_id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_face_paint(this.__wbg_ptr, face_id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get all filled faces as JSON for rendering. Each face carries both the
     * flattened `boundary` polygon (hit tests) and the exact-bézier `outline`
     * (anchor + handles) used to render/export true curves.
     * @returns {string}
     */
    get_filled_faces() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_filled_faces(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the current format version — the newest this build can write.
     * @returns {number}
     */
    get_format_version() {
        const ret = wasm.engine_get_format_version(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get the current Live Paint gap-closing distance.
     * @returns {number}
     */
    get_gap_bridge_distance() {
        const ret = wasm.engine_get_gap_bridge_distance(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get_guide_locks_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_guide_locks_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Guides as JSON: `{"x":[..world x..],"y":[..world y..]}`.
     * @returns {string}
     */
    get_guides_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_guides_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Encoded bytes for a registered image (for the renderer to decode).
     * @param {number} image_id
     * @returns {Uint8Array}
     */
    get_image_bytes(image_id) {
        const ret = wasm.engine_get_image_bytes(this.__wbg_ptr, image_id);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * MIME type for a registered image.
     * @param {number} image_id
     * @returns {string}
     */
    get_image_mime(image_id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_image_mime(this.__wbg_ptr, image_id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Whether an image node samples with nearest-neighbour.
     * @param {number} id
     * @returns {boolean}
     */
    get_image_pixelated(id) {
        const ret = wasm.engine_get_image_pixelated(this.__wbg_ptr, id);
        return ret !== 0;
    }
    /**
     * Edges to bake on Expand: every logical edge of the ACTIVE group with an
     * effective stroke — the painted override if set, else the source shape's
     * own stroke. Expand deletes the originals, so this is what keeps the drawn
     * lines alive. JSON: `[{outline, color, width, cap, join}]`.
     * @returns {string}
     */
    get_live_paint_expand_edges() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_live_paint_expand_edges(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Faces to bake on Expand: every non-outer face with an EFFECTIVE fill —
     * the painted override if set, else the fill of the topmost source shape
     * covering it (Illustrator absorbs source appearance). Faces with no fill
     * are omitted (discarded on expand). JSON: `[{outline, fill}]`.
     * @returns {string}
     */
    get_live_paint_faces() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_live_paint_faces(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The active Live Paint group node id, or -1 if none.
     * @returns {number}
     */
    get_live_paint_group() {
        const ret = wasm.engine_get_live_paint_group(this.__wbg_ptr);
        return ret;
    }
    /**
     * Per-group Live Paint render data for SVG export, mirroring the in-app
     * compositing: every colored face (effective color, tagged with its owning
     * group) that draws UNDER the members' strokes, plus painted edges (on top).
     * JSON: `{"groups":[id,…],"faces":[{group,outline,fill}],"edges":[{group,outline,color,width}]}`.
     * @returns {string}
     */
    get_live_paint_render_data() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_live_paint_render_data(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get_markers_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_markers_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get bounding box of a node in world coordinates: [minX, minY, maxX, maxY]
     * @param {number} id
     * @returns {Float32Array}
     */
    get_node_bounds(id) {
        const ret = wasm.engine_get_node_bounds(this.__wbg_ptr, id);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Get a node's children IDs.
     * @param {number} id
     * @returns {Uint32Array}
     */
    get_node_children(id) {
        const ret = wasm.engine_get_node_children(this.__wbg_ptr, id);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * A node's effects as a serde-tagged JSON array.
     * @param {number} id
     * @returns {string}
     */
    get_node_effects(id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_node_effects(this.__wbg_ptr, id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * A Live Paint group's own gap-closing distance, or -1 when it has none of
     * its own (it inherits the document default).
     * @param {number} id
     * @returns {number}
     */
    get_node_gap_bridge_distance(id) {
        const ret = wasm.engine_get_node_gap_bridge_distance(this.__wbg_ptr, id);
        return ret;
    }
    /**
     * Get a node's geometry as JSON.
     * @param {number} id
     * @returns {string}
     */
    get_node_geometry_json(id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_node_geometry_json(this.__wbg_ptr, id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} id
     * @returns {boolean}
     */
    get_node_is_mask(id) {
        const ret = wasm.engine_get_node_is_mask(this.__wbg_ptr, id);
        return ret !== 0;
    }
    /**
     * Get a single node's full data as JSON. Used by UI panels.
     * @param {number} id
     * @returns {string}
     */
    get_node_json(id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_node_json(this.__wbg_ptr, id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} id
     * @returns {boolean}
     */
    get_node_live_paint(id) {
        const ret = wasm.engine_get_node_live_paint(this.__wbg_ptr, id);
        return ret !== 0;
    }
    /**
     * Get a node's transform as a Vec<f32> (column-major, 9 elements).
     * Used by SVG export which needs the local transform, not the global one.
     * @param {number} id
     * @returns {Float32Array}
     */
    get_node_local_transform(id) {
        const ret = wasm.engine_get_node_local_transform(this.__wbg_ptr, id);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Get a node's locked flag.
     * @param {number} id
     * @returns {boolean}
     */
    get_node_locked(id) {
        const ret = wasm.engine_get_node_locked(this.__wbg_ptr, id);
        return ret !== 0;
    }
    /**
     * Get a node's name.
     * @param {number} id
     * @returns {string}
     */
    get_node_name(id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_node_name(this.__wbg_ptr, id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the per-node vector network as JSON.
     * @param {number} id
     * @returns {string}
     */
    get_node_network_json(id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_node_network_json(this.__wbg_ptr, id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the parent node ID, or -1 if root.
     * @param {number} id
     * @returns {number}
     */
    get_node_parent(id) {
        const ret = wasm.engine_get_node_parent(this.__wbg_ptr, id);
        return ret;
    }
    /**
     * Get a node's style as JSON.
     * @param {number} id
     * @returns {string}
     */
    get_node_style_json(id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_node_style_json(this.__wbg_ptr, id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} id
     * @returns {string}
     */
    get_node_transform_components(id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_node_transform_components(this.__wbg_ptr, id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Returns a pointer to a 9-element f32 array in Skia row-major format.
     * This transposes from the internal column-major storage.
     * @param {number} id
     * @returns {number}
     */
    get_node_transform_ptr(id) {
        const ret = wasm.engine_get_node_transform_ptr(this.__wbg_ptr, id);
        return ret >>> 0;
    }
    /**
     * Get the node type as u32: 0=Path, 1=Rect, 2=Ellipse, 3=Group, 4=Text, 5=Image
     * @param {number} id
     * @returns {number | undefined}
     */
    get_node_type(id) {
        const ret = wasm.engine_get_node_type(this.__wbg_ptr, id);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * Get a node's visible flag.
     * @param {number} id
     * @returns {boolean}
     */
    get_node_visible(id) {
        const ret = wasm.engine_get_node_visible(this.__wbg_ptr, id);
        return ret !== 0;
    }
    /**
     * All painted logical edges as JSON for rendering. Carries the exact-bézier
     * `outline` (anchor + handles) and the flattened `polyline` (fallback).
     * @returns {string}
     */
    get_painted_edges() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_painted_edges(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get_render_buffer() {
        const ret = wasm.engine_get_render_buffer(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get_render_buffer_size() {
        const ret = wasm.engine_get_render_buffer_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Which (family, weight, italic) faces the document's text actually needs.
     * Returned as JSON so the editor can fetch and embed exactly these — there
     * is no point shipping a bold face for text that is never bold.
     * @returns {string}
     */
    get_required_fonts_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_required_fonts_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get root node IDs.
     * @returns {Uint32Array}
     */
    get_root_nodes() {
        const ret = wasm.engine_get_root_nodes(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {string}
     */
    get_scene_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_scene_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    get_selection() {
        const ret = wasm.engine_get_selection(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {string}
     */
    get_swatches_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_swatches_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get_text_paths_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_get_text_paths_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Returns visible node IDs in document draw order (back to front).
     * Uses the spatial index for fast culling, then sorts by scene tree order.
     * @param {number} min_x
     * @param {number} min_y
     * @param {number} max_x
     * @param {number} max_y
     * @returns {Uint32Array}
     */
    get_visible_nodes(min_x, min_y, max_x, max_y) {
        const ret = wasm.engine_get_visible_nodes(this.__wbg_ptr, min_x, min_y, max_x, max_y);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Group selected nodes into a new Group node. Returns the group's id.
     * Deduplicates the selection (drops descendants of selected ancestors).
     * Places the group at the z-position of the topmost member in the common parent.
     * @param {string} ids_json
     * @returns {number}
     */
    group_nodes(ids_json) {
        const ptr0 = passStringToWasm0(ids_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_group_nodes(this.__wbg_ptr, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * True when a cut is waiting to be pasted.
     * @returns {boolean}
     */
    has_clipboard() {
        const ret = wasm.engine_has_clipboard(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check whether a node's local transform has a non-identity linear part
     * (rotation, scale != 1, skew, or flip).
     * @param {number} id
     * @returns {boolean}
     */
    has_non_identity_linear(id) {
        const ret = wasm.engine_has_non_identity_linear(this.__wbg_ptr, id);
        return ret !== 0;
    }
    /**
     * The node a click at this world point lands on, topmost first.
     *
     * Takes `&mut self` for one reason: inside a Live Paint group the question
     * "is this point painted?" is answered by the FACES, and those have to be
     * current before it can be asked. Documents with no Live Paint group skip
     * that entirely and this is a pure read.
     * @param {number} x
     * @param {number} y
     * @returns {number | undefined}
     */
    hit_test(x, y) {
        const ret = wasm.engine_hit_test(this.__wbg_ptr, x, y);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * Group-aware hit test: finds the deepest leaf hit, then walks up the parent
     * chain to find the topmost Group ancestor that is a direct child of root
     * (or of a non-Group parent). Returns that group's ID, or the leaf ID if
     * no Group ancestor exists.
     * @param {number} x
     * @param {number} y
     * @returns {number | undefined}
     */
    hit_test_grouped(x, y) {
        const ret = wasm.engine_hit_test_grouped(this.__wbg_ptr, x, y);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * Mark the vector network as needing recomputation.
     */
    invalidate_vector_network() {
        wasm.engine_invalidate_vector_network(this.__wbg_ptr);
    }
    /**
     * True when this node OR any ancestor is locked. The raw flag is not
     * enough for anything interactive: locking a group is meant to protect its
     * contents, so every "can the user grab this?" test has to read the chain.
     * @param {number} id
     * @returns {boolean}
     */
    is_locked_in_tree(id) {
        const ret = wasm.engine_is_locked_in_tree(this.__wbg_ptr, id);
        return ret !== 0;
    }
    /**
     * @param {number} id
     * @returns {boolean}
     */
    is_node_dirty(id) {
        const ret = wasm.engine_is_node_dirty(this.__wbg_ptr, id);
        return ret !== 0;
    }
    /**
     * Check if the vector network is dirty.
     * @returns {boolean}
     */
    is_vector_network_dirty() {
        const ret = wasm.engine_is_vector_network_dirty(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * True when this node and every ancestor is visible — what the user can
     * actually see, as opposed to the node's own flag.
     * @param {number} id
     * @returns {boolean}
     */
    is_visible_in_tree(id) {
        const ret = wasm.engine_is_visible_in_tree(this.__wbg_ptr, id);
        return ret !== 0;
    }
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
     * @param {Uint8Array} data
     * @returns {string}
     */
    load_document(data) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.engine_load_document(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Base64 counterpart of `load_document`, for the payload embedded in an
     * exported SVG. Same JSON status contract.
     * @param {string} b64
     * @returns {string}
     */
    load_document_base64(b64) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.engine_load_document_base64(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} id
     * @param {number} dx
     * @param {number} dy
     */
    move_node(id, dx, dy) {
        wasm.engine_move_node(this.__wbg_ptr, id, dx, dy);
    }
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
     * @param {string} moves_json
     */
    move_nodes(moves_json) {
        const ptr0 = passStringToWasm0(moves_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_move_nodes(this.__wbg_ptr, ptr0, len0);
    }
    constructor() {
        const ret = wasm.engine_new();
        this.__wbg_ptr = ret;
        EngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Paste every clipboard root back into the document at the top level,
     * offset by (dx, dy). The clipboard is NOT consumed — pasting twice gives
     * two copies, the way it does everywhere else. Returns the new ids.
     * @param {number} dx
     * @param {number} dy
     * @returns {Uint32Array}
     */
    paste_clipboard(dx, dy) {
        const ret = wasm.engine_paste_clipboard(this.__wbg_ptr, dx, dy);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Drop embedded faces no text node references any more, so a document
     * doesn't accumulate megabytes of fonts from text that has been deleted.
     * @returns {number}
     */
    prune_unused_fonts() {
        const ret = wasm.engine_prune_unused_fonts(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Nearest paintable edge to a point (world units), or -1.
     * @param {number} x
     * @param {number} y
     * @param {number} tolerance
     * @returns {number}
     */
    query_edge_at(x, y, tolerance) {
        const ret = wasm.engine_query_edge_at(this.__wbg_ptr, x, y, tolerance);
        return ret;
    }
    /**
     * Query which face contains the given point. Returns face ID or -1.
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    query_face_at(x, y) {
        const ret = wasm.engine_query_face_at(this.__wbg_ptr, x, y);
        return ret;
    }
    /**
     * Rebuild the planar graph from all visible paths.
     */
    rebuild_vector_network() {
        wasm.engine_rebuild_vector_network(this.__wbg_ptr);
    }
    /**
     * Register encoded image bytes (PNG/JPEG/…), returning an image id.
     * Content-addressed: identical bytes reuse the same id (dedup).
     * @param {Uint8Array} bytes
     * @param {string} mime
     * @returns {number}
     */
    register_image(bytes, mime) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(mime, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.engine_register_image(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret >>> 0;
    }
    /**
     * Remove an artboard. Returns true if one was removed.
     * @param {number} id
     * @returns {boolean}
     */
    remove_artboard(id) {
        const ret = wasm.engine_remove_artboard(this.__wbg_ptr, id);
        return ret !== 0;
    }
    /**
     * Remove the guide at `index` on the given axis.
     * @param {string} axis
     * @param {number} index
     * @returns {boolean}
     */
    remove_guide(axis, index) {
        const ptr0 = passStringToWasm0(axis, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_remove_guide(this.__wbg_ptr, ptr0, len0, index);
        return ret !== 0;
    }
    /**
     * Remove a vertex (and its edges) from a node's network.
     * @param {number} node_id
     * @param {number} vertex_idx
     */
    remove_network_vertex(node_id, vertex_idx) {
        wasm.engine_remove_network_vertex(this.__wbg_ptr, node_id, vertex_idx);
    }
    /**
     * @param {number} id
     */
    remove_node(id) {
        wasm.engine_remove_node(this.__wbg_ptr, id);
    }
    /**
     * The render-buffer protocol version the engine emits. Exposed so JS and
     * tests can assert the freshly-built wasm matches what the reader expects.
     * @returns {number}
     */
    static render_protocol_version() {
        const ret = wasm.engine_render_protocol_version();
        return ret >>> 0;
    }
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
     * @param {number} node_id
     * @param {number | null | undefined} new_parent
     * @param {number} index
     * @returns {boolean}
     */
    reorder_node(node_id, new_parent, index) {
        const ret = wasm.engine_reorder_node(this.__wbg_ptr, node_id, isLikeNone(new_parent) ? Number.MAX_SAFE_INTEGER : (new_parent) >>> 0, index);
        return ret !== 0;
    }
    /**
     * Batch variant of [`reorder_node`]. Moves every node in `ids_json` (a JSON
     * array of ids, given in bottom-up z-order) so they become contiguous
     * siblings under `new_parent` (or roots when `None`), starting at `index`.
     * Their relative order is preserved. Nodes that fail validation (missing,
     * non-group parent, or a cycle) are skipped. Returns the number moved.
     * @param {string} ids_json
     * @param {number | null | undefined} new_parent
     * @param {number} index
     * @returns {number}
     */
    reorder_nodes(ids_json, new_parent, index) {
        const ptr0 = passStringToWasm0(ids_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_reorder_nodes(this.__wbg_ptr, ptr0, len0, isLikeNone(new_parent) ? Number.MAX_SAFE_INTEGER : (new_parent) >>> 0, index);
        return ret >>> 0;
    }
    /**
     * Replace a node's geometry with a new path. Used for "Create Outlines".
     * @param {number} id
     * @param {string} subpaths_json
     * @returns {boolean}
     */
    replace_geometry_with_path(id, subpaths_json) {
        const ptr0 = passStringToWasm0(subpaths_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_replace_geometry_with_path(this.__wbg_ptr, id, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Resize a node's geometry to new width/height.
     * @param {number} id
     * @param {number} new_w
     * @param {number} new_h
     */
    resize_node(id, new_w, new_h) {
        wasm.engine_resize_node(this.__wbg_ptr, id, new_w, new_h);
    }
    /**
     * Resolve a Path node's per-vertex corner radii into an explicit rounded
     * outline and return it as JSON subpaths. Non-path geometry (or a path
     * with no rounding) yields the plain subpaths. Consumed by SVG export and
     * boolean ops so their output matches the rendered (rounded) shape.
     * @param {number} id
     * @returns {string}
     */
    resolve_subpaths_json(id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_resolve_subpaths_json(this.__wbg_ptr, id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} id
     * @param {boolean} multi
     */
    select_node(id, multi) {
        wasm.engine_select_node(this.__wbg_ptr, id, multi);
    }
    /**
     * @param {number} id
     */
    send_backward(id) {
        wasm.engine_send_backward(this.__wbg_ptr, id);
    }
    /**
     * @param {number} id
     */
    send_to_back(id) {
        wasm.engine_send_to_back(this.__wbg_ptr, id);
    }
    /**
     * Serialize scene to protobuf bytes (.vec file format).
     * @returns {Uint8Array}
     */
    serialize_proto() {
        const ret = wasm.engine_serialize_proto(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Serialize scene to base64-encoded protobuf (for SVG embedding).
     * @returns {string}
     */
    serialize_proto_base64() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_serialize_proto_base64(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {Uint8Array}
     */
    serialize_scene() {
        const ret = wasm.engine_serialize_scene(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {number} id
     * @param {number} r
     * @param {number} g
     * @param {number} b
     * @param {number} a_
     * @returns {boolean}
     */
    set_artboard_background(id, r, g, b, a_) {
        const ret = wasm.engine_set_artboard_background(this.__wbg_ptr, id, r, g, b, a_);
        return ret !== 0;
    }
    /**
     * Resize/move an artboard. Rejects non-positive dimensions. Returns true on success.
     * @param {number} id
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     * @returns {boolean}
     */
    set_artboard_bounds(id, x, y, w, h) {
        const ret = wasm.engine_set_artboard_bounds(this.__wbg_ptr, id, x, y, w, h);
        return ret !== 0;
    }
    /**
     * @param {number} id
     * @param {string} name
     * @returns {boolean}
     */
    set_artboard_name(id, name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_set_artboard_name(this.__wbg_ptr, id, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Push a recomputed outline (JSON `Vec<Subpath>`, in the group's LOCAL space)
     * into a Boolean Group's cache and clear its dirty flag. No-op otherwise.
     * @param {number} id
     * @param {string} subpaths_json
     */
    set_bool_cache(id, subpaths_json) {
        const ptr0 = passStringToWasm0(subpaths_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_set_bool_cache(this.__wbg_ptr, id, ptr0, len0);
    }
    /**
     * Set (op = 0..3) or clear (op < 0) the boolean operation on a Group node,
     * making it a non-destructive Boolean Group. No-op on non-groups. Flags the
     * group so JS recomputes its cached outline on the next drain.
     * @param {number} id
     * @param {number} op
     */
    set_boolean_op(id, op) {
        wasm.engine_set_boolean_op(this.__wbg_ptr, id, op);
    }
    /**
     * Replace the document's identity block. `created_at_ms`/`modified_at_ms`
     * are Unix epoch milliseconds; 0 means unknown.
     * @param {string} uuid
     * @param {number} created_at_ms
     * @param {number} modified_at_ms
     * @param {string} app_version
     * @param {string} title
     */
    set_document_meta(uuid, created_at_ms, modified_at_ms, app_version, title) {
        const ptr0 = passStringToWasm0(uuid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(app_version, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(title, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        wasm.engine_set_document_meta(this.__wbg_ptr, ptr0, len0, created_at_ms, modified_at_ms, ptr1, len1, ptr2, len2);
    }
    /**
     * @param {number} w
     * @param {number} h
     */
    set_document_size(w, h) {
        wasm.engine_set_document_size(this.__wbg_ptr, w, h);
    }
    /**
     * Paint a logical edge with a stroke color/width. The paint is anchored in
     * the source path's local space so it follows the path when it moves.
     * @param {number} edge_id
     * @param {number} r
     * @param {number} g
     * @param {number} b
     * @param {number} a
     * @param {number} width
     */
    set_edge_paint(edge_id, r, g, b, a, width) {
        wasm.engine_set_edge_paint(this.__wbg_ptr, edge_id, r, g, b, a, width);
    }
    /**
     * Assign a solid fill colour to a face.
     * @param {number} face_id
     * @param {number} r
     * @param {number} g
     * @param {number} b
     * @param {number} a
     */
    set_face_fill(face_id, r, g, b, a) {
        wasm.engine_set_face_fill(this.__wbg_ptr, face_id, r, g, b, a);
    }
    /**
     * Assign any paint to a face — the gradient path. `paint_json` is the same
     * shape a node's `style.fills[0]` uses. Returns false if it doesn't parse,
     * rather than silently leaving the face unpainted.
     *
     * Gradient coordinates are WORLD space here: a face is a world-space
     * outline with no transform of its own, unlike a node's fill.
     * @param {number} face_id
     * @param {string} paint_json
     * @returns {boolean}
     */
    set_face_paint(face_id, paint_json) {
        const ptr0 = passStringToWasm0(paint_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_set_face_paint(this.__wbg_ptr, face_id, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Set the Live Paint gap-closing distance (world units). Open path ends
     * within this distance are bridged so the enclosed region is fillable.
     * 0 disables gap closing.
     * @param {number} distance
     */
    set_gap_bridge_distance(distance) {
        wasm.engine_set_gap_bridge_distance(this.__wbg_ptr, distance);
    }
    /**
     * Set gap tolerance for the vector network.
     * @param {number} tolerance
     */
    set_gap_tolerance(tolerance) {
        wasm.engine_set_gap_tolerance(this.__wbg_ptr, tolerance);
    }
    /**
     * Move an existing guide (live drag; no history).
     * @param {string} axis
     * @param {number} index
     * @param {number} pos
     * @returns {boolean}
     */
    set_guide(axis, index, pos) {
        const ptr0 = passStringToWasm0(axis, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_set_guide(this.__wbg_ptr, ptr0, len0, index, pos);
        return ret !== 0;
    }
    /**
     * @param {string} json
     */
    set_guide_locks_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_set_guide_locks_json(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Add a raster image node referencing a previously-registered image id.
     * Set whether an image node samples with nearest-neighbour when scaled.
     *
     * SVG spells this `image-rendering`; `optimizeSpeed`, `pixelated` and
     * `crisp-edges` all mean "do not smooth". Without it, magnifying pixel art
     * blurs it, which is both wrong per spec and the opposite of what anyone
     * drawing pixel art wants.
     * @param {number} id
     * @param {boolean} on
     * @returns {boolean}
     */
    set_image_pixelated(id, on) {
        const ret = wasm.engine_set_image_pixelated(this.__wbg_ptr, id, on);
        return ret !== 0;
    }
    /**
     * Scope Live Paint to a group's descendants (an Illustrator "Live Paint
     * Group"). Pass 0 to clear the scope (whole scene participates again).
     * @param {number} node_id
     */
    set_live_paint_group(node_id) {
        wasm.engine_set_live_paint_group(this.__wbg_ptr, node_id);
    }
    /**
     * @param {string} json
     */
    set_markers_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_set_markers_json(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Update a vertex position and handles in a node's network.
     * @param {number} node_id
     * @param {number} vertex_idx
     * @param {number} x
     * @param {number} y
     * @param {number} hin_x
     * @param {number} hin_y
     * @param {boolean} has_hin
     * @param {number} hout_x
     * @param {number} hout_y
     * @param {boolean} has_hout
     */
    set_network_vertex(node_id, vertex_idx, x, y, hin_x, hin_y, has_hin, hout_x, hout_y, has_hout) {
        wasm.engine_set_network_vertex(this.__wbg_ptr, node_id, vertex_idx, x, y, hin_x, hin_y, has_hin, hout_x, hout_y, has_hout);
    }
    /**
     * Replace a node's effects from a JSON array of `Effect` (serde-tagged,
     * e.g. `[{"Blur":{"radius":6}}, {"DropShadow":{"dx":4,"dy":4,"blur":8,
     * "color":{"r":0,"g":0,"b":0,"a":0.5}}}]`).
     * @param {number} id
     * @param {string} effects_json
     */
    set_node_effects(id, effects_json) {
        const ptr0 = passStringToWasm0(effects_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_set_node_effects(this.__wbg_ptr, id, ptr0, len0);
    }
    /**
     * Set one Live Paint group's own gap-closing distance (world units), or
     * clear it with a negative value so the group goes back to inheriting the
     * document default. No-op on a node that isn't a Live Paint group.
     * @param {number} id
     * @param {number} distance
     */
    set_node_gap_bridge_distance(id, distance) {
        wasm.engine_set_node_gap_bridge_distance(this.__wbg_ptr, id, distance);
    }
    /**
     * Toggle whether a node masks the siblings painted above it. Marks the
     * parent dirty so the mask span is recomputed on the next render.
     * @param {number} id
     * @param {boolean} is_mask
     */
    set_node_is_mask(id, is_mask) {
        wasm.engine_set_node_is_mask(this.__wbg_ptr, id, is_mask);
    }
    /**
     * Mark (or unmark) a Group node as a Live Paint group. No-op on non-groups.
     * @param {number} id
     * @param {boolean} live_paint
     */
    set_node_live_paint(id, live_paint) {
        wasm.engine_set_node_live_paint(this.__wbg_ptr, id, live_paint);
    }
    /**
     * @param {number} id
     * @param {boolean} locked
     */
    set_node_locked(id, locked) {
        wasm.engine_set_node_locked(this.__wbg_ptr, id, locked);
    }
    /**
     * Set the mask coverage source: 0 = alpha, 1 = luminance (reserved).
     * @param {number} id
     * @param {number} mask_type
     */
    set_node_mask_type(id, mask_type) {
        wasm.engine_set_node_mask_type(this.__wbg_ptr, id, mask_type);
    }
    /**
     * @param {number} id
     * @param {string} name
     */
    set_node_name(id, name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_set_node_name(this.__wbg_ptr, id, ptr0, len0);
    }
    /**
     * Set a node's absolute position (translation part of its local transform).
     * @param {number} id
     * @param {number} x
     * @param {number} y
     */
    set_node_position(id, x, y) {
        wasm.engine_set_node_position(this.__wbg_ptr, id, x, y);
    }
    /**
     * Set fill color on a specific region of a node's network.
     * @param {number} node_id
     * @param {number} region_idx
     * @param {number} r
     * @param {number} g
     * @param {number} b
     * @param {number} a
     */
    set_node_region_fill(node_id, region_idx, r, g, b, a) {
        wasm.engine_set_node_region_fill(this.__wbg_ptr, node_id, region_idx, r, g, b, a);
    }
    /**
     * @param {number} id
     * @param {number} deg
     */
    set_node_rotation(id, deg) {
        wasm.engine_set_node_rotation(this.__wbg_ptr, id, deg);
    }
    /**
     * Set rotation while keeping a reference point fixed. `ax`/`ay` are the
     * normalized bounding-box anchor (0..1); (0.5,0.5) is the center and
     * matches `set_node_rotation`.
     * @param {number} id
     * @param {number} deg
     * @param {number} ax
     * @param {number} ay
     */
    set_node_rotation_about(id, deg, ax, ay) {
        wasm.engine_set_node_rotation_about(this.__wbg_ptr, id, deg, ax, ay);
    }
    /**
     * Scale factors of ~0 (or non-finite) are rejected: they collapse the
     * matrix and the geometry could never be recovered by scaling back up.
     * @param {number} id
     * @param {number} sx
     * @param {number} sy
     */
    set_node_scale(id, sx, sy) {
        wasm.engine_set_node_scale(this.__wbg_ptr, id, sx, sy);
    }
    /**
     * Set scale while keeping a reference point fixed (see `set_node_rotation_about`).
     * @param {number} id
     * @param {number} sx
     * @param {number} sy
     * @param {number} ax
     * @param {number} ay
     */
    set_node_scale_about(id, sx, sy, ax, ay) {
        wasm.engine_set_node_scale_about(this.__wbg_ptr, id, sx, sy, ax, ay);
    }
    /**
     * Each angle is clamped to ±89°: at 90° the corresponding edge has turned
     * a full quarter-turn and the shape degenerates to a line.
     *
     * The pair must also satisfy |x_deg + y_deg| < 90°, or the two edges are
     * parallel and the shape collapses. That case is not clamped — it is
     * rejected by the `is_valid` rollback in `set_components_about_center`,
     * leaving the node exactly as it was (same contract as a zero scale).
     * @param {number} id
     * @param {number} x_deg
     * @param {number} y_deg
     */
    set_node_skew(id, x_deg, y_deg) {
        wasm.engine_set_node_skew(this.__wbg_ptr, id, x_deg, y_deg);
    }
    /**
     * @param {number} id
     * @param {string} style_json
     */
    set_node_style(id, style_json) {
        const ptr0 = passStringToWasm0(style_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_set_node_style(this.__wbg_ptr, id, ptr0, len0);
    }
    /**
     * @param {number} id
     * @param {string} json
     */
    set_node_transform_components(id, json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_set_node_transform_components(this.__wbg_ptr, id, ptr0, len0);
    }
    /**
     * Set a node's full local transform from a JSON array of 9 f32 values (column-major, matching `Mat3::from_cols_array`).
     * @param {number} id
     * @param {string} transform_json
     */
    set_node_transform_matrix(id, transform_json) {
        const ptr0 = passStringToWasm0(transform_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_set_node_transform_matrix(this.__wbg_ptr, id, ptr0, len0);
    }
    /**
     * @param {number} id
     * @param {boolean} visible
     */
    set_node_visible(id, visible) {
        wasm.engine_set_node_visible(this.__wbg_ptr, id, visible);
    }
    /**
     * @param {number} child_id
     * @param {number | null} [parent_id]
     * @returns {boolean}
     */
    set_parent(child_id, parent_id) {
        const ret = wasm.engine_set_parent(this.__wbg_ptr, child_id, isLikeNone(parent_id) ? Number.MAX_SAFE_INTEGER : (parent_id) >>> 0);
        return ret !== 0;
    }
    /**
     * Set this engine's site before editing a shared document. Concurrent
     * editors must each be given a different one; sessions that never overlap
     * may reuse them freely.
     * @param {number} site
     */
    set_site_id(site) {
        wasm.engine_set_site_id(this.__wbg_ptr, site);
    }
    /**
     * @param {string} json
     */
    set_swatches_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_set_swatches_json(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Update a text node's content and font size.
     * @param {number} id
     * @param {string} content
     * @param {number} font_size
     */
    set_text_content(id, content, font_size) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_set_text_content(this.__wbg_ptr, id, ptr0, len0, font_size);
    }
    /**
     * @param {string} json
     */
    set_text_paths_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_set_text_paths_json(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Update a text node's typography properties (font family, alignment, line height).
     * @param {number} id
     * @param {string} font_family
     * @param {number} text_align
     * @param {number} line_height
     */
    set_text_properties(id, font_family, text_align, line_height) {
        const ptr0 = passStringToWasm0(font_family, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_set_text_properties(this.__wbg_ptr, id, ptr0, len0, text_align, line_height);
    }
    /**
     * Update a text node's weight/style: font_weight (100–900), italic,
     * letter_spacing (local units).
     * @param {number} id
     * @param {number} font_weight
     * @param {boolean} italic
     * @param {number} letter_spacing
     */
    set_text_style(id, font_weight, italic, letter_spacing) {
        wasm.engine_set_text_style(this.__wbg_ptr, id, font_weight, italic, letter_spacing);
    }
    /**
     * @returns {number}
     */
    site_id() {
        const ret = wasm.engine_site_id(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Drain and return the ids of Boolean Groups whose outline is stale, ordered
     * DEEPEST-FIRST so nested groups recompute before their parents. JSON array.
     * @returns {string}
     */
    take_dirty_boolean_groups() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_take_dirty_boolean_groups(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Stamp the modification time, called by the editor just before a save.
     * @param {number} now_ms
     */
    touch_modified_at(now_ms) {
        wasm.engine_touch_modified_at(this.__wbg_ptr, now_ms);
    }
    /**
     * Ungroup a group node, promoting its children to the group's parent level.
     * Children are inserted at the group's z-position, preserving their global positions.
     * @param {number} id
     */
    ungroup_node(id) {
        wasm.engine_ungroup_node(this.__wbg_ptr, id);
    }
    update_all_global_transforms() {
        wasm.engine_update_all_global_transforms(this.__wbg_ptr);
    }
    update_all_spatial_indices() {
        wasm.engine_update_all_spatial_indices(this.__wbg_ptr);
    }
    /**
     * @param {number} id
     * @param {string} subpaths_json
     */
    update_path_points(id, subpaths_json) {
        const ptr0 = passStringToWasm0(subpaths_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_update_path_points(this.__wbg_ptr, id, ptr0, len0);
    }
    /**
     * @param {Uint32Array} visible_ids
     * @param {Uint32Array} sprite_roots
     */
    update_render_buffer(visible_ids, sprite_roots) {
        const ptr0 = passArray32ToWasm0(visible_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(sprite_roots, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.engine_update_render_buffer(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * Cull + build in one call: run the R-tree viewport query internally and
     * build the render buffer directly, avoiding the ordered visible-id Vec,
     * its marshal across the wasm boundary, and the redundant second tree walk
     * that the separate `get_visible_nodes` + `update_render_buffer` pair does.
     * Used for ordinary frames; the renderer keeps the split path only for the
     * drag/snapshot/bake passes that need a JS-side id subset.
     * @param {number} min_x
     * @param {number} min_y
     * @param {number} max_x
     * @param {number} max_y
     * @param {Uint32Array} sprite_roots
     */
    update_render_buffer_culled(min_x, min_y, max_x, max_y, sprite_roots) {
        const ptr0 = passArray32ToWasm0(sprite_roots, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.engine_update_render_buffer_culled(this.__wbg_ptr, min_x, min_y, max_x, max_y, ptr0, len0);
    }
}
if (Symbol.dispose) Engine.prototype[Symbol.dispose] = Engine.prototype.free;

export class History {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HistoryFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_history_free(ptr, 0);
    }
    /**
     * @param {number} max_size
     */
    constructor(max_size) {
        const ret = wasm.history_new(max_size);
        this.__wbg_ptr = ret;
        HistoryFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} data
     */
    push_state(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.history_push_state(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {Uint8Array} current_state
     * @returns {Uint8Array | undefined}
     */
    redo(current_state) {
        const ptr0 = passArray8ToWasm0(current_state, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.history_redo(this.__wbg_ptr, ptr0, len0);
        let v2;
        if (ret[0] !== 0) {
            v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * @returns {number}
     */
    redo_len() {
        const ret = wasm.history_redo_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {Uint8Array} current_state
     * @returns {Uint8Array | undefined}
     */
    undo(current_state) {
        const ptr0 = passArray8ToWasm0(current_state, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.history_undo(this.__wbg_ptr, ptr0, len0);
        let v2;
        if (ret[0] !== 0) {
            v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * How many states are on each stack. The editor keeps a parallel stack of
     * the *mode* each state was captured in (which shape was being
     * node-edited, which group you had drilled into) so undo can put you back
     * where you were, and it trims that mirror against these lengths — this
     * struct silently drops the oldest state once `max_size` is exceeded, and
     * a mirror that missed the drop would hand every undo the wrong mode.
     * @returns {number}
     */
    undo_len() {
        const ret = wasm.history_undo_len(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) History.prototype[Symbol.dispose] = History.prototype.free;

/**
 * @enum {0 | 1 | 2 | 3 | 4 | 5}
 */
export const NodeType = Object.freeze({
    Path: 0, "0": "Path",
    Rect: 1, "1": "Rect",
    Ellipse: 2, "2": "Ellipse",
    Group: 3, "3": "Group",
    Text: 4, "4": "Text",
    Image: 5, "5": "Image",
});
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_error_d94e07c0bfeb9db7: function(arg0, arg1) {
            console.error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./engine_bg.js": import0,
    };
}

const EngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_engine_free(ptr, 1));
const HistoryFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_history_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('engine_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
