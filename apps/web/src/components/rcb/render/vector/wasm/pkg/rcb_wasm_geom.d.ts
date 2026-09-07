/* tslint:disable */
/* eslint-disable */

/**
 * Polygon boolean fold. `op`: 0=union 1=difference 2=intersection 3=xor.
 * `packed` / return: see `boolean` module packing layout.
 */
export function boolean_polygons(op: number, packed: Float32Array): Float32Array;

export function densify_path_d(d: string, flatness: number): Float32Array;

/**
 * Stroke centerline offset → packed MultiPolygon (same layout as boolean).
 * `join`: 0=bevel 1=miter 2=round · `cap`: 0=butt 1=round 2=square
 * Empty return = hard failure (TS falls back to JS outline).
 */
export function offset_polyline(xy: Float32Array, width: number, closed: boolean, join: number, cap: number, miter_limit: number, round_approx: number): Float32Array;

/**
 * Open RDP simplify. Empty = failure.
 */
export function simplify_rdp(xy: Float32Array, epsilon: number): Float32Array;

/**
 * Closed-ring RDP (drops closing duplicate). Empty = failure.
 */
export function simplify_rdp_closed(xy: Float32Array, epsilon: number): Float32Array;

/**
 * Batch: each job is [pointCount, widthBits, flags, ...xy]
 * flags: bit0 closed, bit1 want_fill, bit2 want_stroke; align encoded in high bits unused — align passed as parallel string not feasible.
 * Simpler batch API: process one mesh request encoded as floats.
 */
export function tessellate_batch_fill(xy_all: Float32Array, counts: Uint32Array): Float32Array;

export function tessellate_fill(xy: Float32Array): Float32Array;

/**
 * `holes_flat`: concatenated hole rings; `hole_counts`: vertex count per hole.
 * Uses i_overlay difference + slit (not keyhole bridge) so donuts stay hollow.
 */
export function tessellate_fill_with_holes(outer: Float32Array, holes_flat: Float32Array, hole_counts: Uint32Array): Float32Array;

export function tessellate_stroke(xy: Float32Array, width: number, closed: boolean, align: string, linejoin: string, miter_limit: number): Float32Array;

/**
 * Trace solid + holes from RGBA ImageData. Packed contours; `[]` fail, `[0]` empty.
 */
export function trace_rgba_contours(rgba: Uint8Array, width: number, height: number, alpha_threshold: number): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly boolean_polygons: (a: number, b: number, c: number, d: number) => void;
    readonly densify_path_d: (a: number, b: number, c: number, d: number) => void;
    readonly offset_polyline: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly simplify_rdp: (a: number, b: number, c: number, d: number) => void;
    readonly simplify_rdp_closed: (a: number, b: number, c: number, d: number) => void;
    readonly tessellate_batch_fill: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly tessellate_fill: (a: number, b: number, c: number) => void;
    readonly tessellate_fill_with_holes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly tessellate_stroke: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly trace_rgba_contours: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
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
