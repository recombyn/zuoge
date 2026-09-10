/**
 * Type definitions for the vector editor scene data.
 * These types mirror the Rust Engine's JSON serialization format.
 */

/** RGBA color in 0–1 range. */
export interface Color {
    r: number;
    g: number;
    b: number;
    a: number;
}

/** A gradient color stop. */
export interface GradientStop {
    offset: number;
    color: Color;
}

/** Gradient definition. */
export interface Gradient {
    gradient_type: 'Linear' | 'Radial';
    stops: GradientStop[];
    start_x: number;
    start_y: number;
    end_x: number;
    end_y: number;
    /** spreadMethod: 0 = pad, 1 = repeat, 2 = reflect. */
    spread?: number;
    /** Radial focal point; absent = concentric (focal at center, fr 0). */
    focal?: { x: number; y: number; r: number };
    /** Gradient→local affine [a,b,c,d,e,f] for rotated/elliptical radials.
     *  When set, start/end/focal are raw gradient-space coords (renderer applies
     *  this as the shader local matrix); absent = baked circular/linear form. */
    transform?: number[];
}

/** A tiled-image pattern fill (matches the engine's Pattern struct). */
export interface Pattern {
    image_id: number;
    width: number;
    height: number;
    /** Pattern→local affine, 6 floats [a,b,c,d,e,f]. */
    transform?: number[];
}

/** Direction handles of a mesh vertex, ABSOLUTE node-local coords.
 *  Missing = auto (1/3 of the way toward the neighboring vertex).
 *  e = +u (next column), w = -u, s = +v (next row), n = -v. */
export interface MeshVertexHandles {
    e?: [number, number];
    w?: [number, number];
    s?: [number, number];
    n?: [number, number];
}

/** One mesh grid vertex: position, color, and bezier handles along the grid lines. */
export interface MeshVertex {
    x: number;
    y: number;
    color: Color;
    handles?: MeshVertexHandles;
}

/** Coons-patch mesh fill: rows×cols patches, (rows+1)*(cols+1) vertices
 *  stored row-major in node-local coords (matches the engine's MeshGradient). */
export interface MeshGradient {
    rows: number;
    cols: number;
    vertices: MeshVertex[];
}

/**
 * A paint can be a solid color, a gradient, a tiled-image pattern, or a
 * Coons-patch mesh gradient.
 * Matches the Rust engine's Paint enum (distinguished by a marker field):
 * - Solid:    `{ r, g, b, a }`
 * - Gradient: `{ gradient_type, stops, start_x, start_y, end_x, end_y }`
 * - Pattern:  `{ image_id, width, height, transform }`
 * - Mesh:     `{ rows, cols, vertices }`
 */
export type Paint = Color | Gradient | Pattern | MeshGradient;

/** Type guard: check if a Paint is a Gradient. */
export function isGradient(paint: Paint): paint is Gradient {
    return 'gradient_type' in paint;
}

/** Type guard: check if a Paint is a Pattern. */
export function isPattern(paint: Paint): paint is Pattern {
    return 'image_id' in paint;
}

/** Type guard: check if a Paint is a mesh gradient. */
export function isMeshGradient(paint: Paint): paint is MeshGradient {
    return 'vertices' in paint && 'rows' in paint;
}

/** Type guard: check if a Paint is a plain solid color. */
export function isSolid(paint: Paint): paint is Color {
    return !isGradient(paint) && !isPattern(paint) && !isMeshGradient(paint);
}

/** Stroke Alignment */
export enum StrokeAlignment {
    Center = 'Center',
    Inner = 'Inner',
    Outer = 'Outer',
}

/** Stroke definition */
export interface Stroke {
    paint: Paint | null;
    width: number;
    cap: number;
    join: number;
    dash_array: number[];
    dash_offset: number;
    miter_limit: number;
    alignment: StrokeAlignment;
}

/** Decomposed 2D transform components (matches engine's TransformComponents). */
export interface Transform2D {
    x: number;
    y: number;
    rotation_deg: number;
    skew_x_deg: number;
    skew_y_deg: number;
    scale_x: number;
    scale_y: number;
}

/** Style properties for a scene node.
 *  The canonical paint sources are `fills` and `strokes` arrays.
 *  Legacy scalar fields (fill, stroke, stroke_width, etc.) are kept as optional
 *  for backwards-compatible deserialization but should not be relied upon. */
export interface NodeStyle {
    /** @deprecated Use `fills` array instead. */
    fill?: Paint | null;
    /** @deprecated Use `strokes` array instead. */
    stroke?: Paint | null;
    /** @deprecated Use `strokes[].width` instead. */
    stroke_width?: number;
    opacity: number;
    /** @deprecated Use `strokes[].cap` instead. */
    stroke_cap?: number;
    /** @deprecated Use `strokes[].join` instead. */
    stroke_join?: number;
    /** @deprecated Use `strokes[].dash_array` instead. */
    dash_array?: number[];
    /** @deprecated Use `strokes[].dash_offset` instead. */
    dash_offset?: number;
    corner_radius: number;
    blend_mode: number;
    fill_rule: number;
    /** @deprecated Use `strokes[].miter_limit` instead. */
    miter_limit?: number;
    /** @deprecated Subsumed by fills array. */
    fill_opacity?: number;
    fills: Paint[];
    strokes: Stroke[];
    /** Post-processing effects (serde-tagged): {Blur:{radius}} | {DropShadow:{dx,dy,blur,color}}. */
    effects?: EffectData[];
}

/** A serde-tagged Effect (matches the engine's `Effect` enum JSON). */
export type EffectData =
    | { Blur: { radius: number } }
    | {
          DropShadow: {
              dx: number;
              dy: number;
              blur: number;
              color: { r: number; g: number; b: number; a: number };
          };
      }
    | { ColorMatrix: { matrix: number[]; linear_rgb?: boolean } };

/** A cubic Bézier path point with incoming/outgoing control points. */
/** Arrowhead / line-ending marker kind for a path end. */
export type MarkerKind = 'none' | 'arrow' | 'circle' | 'square';

/** Markers at a path's start and end (Illustrator's stroke arrowheads). */
export interface NodeMarkers {
    start?: MarkerKind;
    end?: MarkerKind;
}

export interface PathPoint {
    x: number;
    y: number;
    /** Incoming control point [x, y]. */
    cp1: [number, number];
    /** Outgoing control point [x, y]. */
    cp2: [number, number];
    /** Non-destructive parametric corner radius at this vertex (default 0). */
    corner_radius?: number;
}

/** A subpath — a sequence of connected path points with an explicit closed flag. */
export interface Subpath {
    points: PathPoint[];
    closed: boolean;
}

/** Rect geometry. */
export interface RectGeometry {
    width: number;
    height: number;
}

/** Ellipse geometry. */
export interface EllipseGeometry {
    radius_x: number;
    radius_y: number;
}

/** Path geometry. */
export interface PathGeometry {
    subpaths: Subpath[];
    /** Per-node vector network (graph-based editing source of truth). */
    network?: NodeVectorNetwork;
}

// ─── Per-Node Vector Network Types ─────────────────────────────────────

/** A vertex in the per-node vector network. */
export interface NetworkVertex {
    position: [number, number];
    /** Incoming control handle (absolute position). */
    handle_in?: [number, number];
    /** Outgoing control handle (absolute position). */
    handle_out?: [number, number];
    /** Non-destructive parametric corner radius at this vertex (default 0). */
    corner_radius?: number;
}

/** An edge connecting two vertices. */
export interface NetworkEdge {
    start_vertex: number;
    end_vertex: number;
}

/** An enclosed region with an independent fill style. */
export interface NetworkRegion {
    /** Ordered edge indices forming a closed loop. */
    edge_loop: number[];
    /** Fill color for this region. */
    fill?: Color;
}

/** Per-node vector network — the graph-based path representation. */
export interface NodeVectorNetwork {
    vertices: NetworkVertex[];
    edges: NetworkEdge[];
    regions: NetworkRegion[];
}

/** Text geometry. */
export interface TextGeometry {
    content: string;
    font_size: number;
    font_family: string;
    text_align: number;
    line_height: number;
    font_weight?: number;
    italic?: boolean;
    letter_spacing?: number;
}

export interface ImageGeometry {
    width: number;
    height: number;
    image_id: number;
    /** Sample with nearest-neighbour when scaled — SVG `image-rendering:
     *  optimizeSpeed | pixelated | crisp-edges`. Absent means smooth. */
    pixelated?: boolean;
}

/**
 * Discriminated geometry union.
 * Exactly one of the keys will be present.
 */
export interface NodeGeometry {
    Rect?: RectGeometry;
    Ellipse?: EllipseGeometry;
    Path?: PathGeometry;
    Text?: TextGeometry;
    Image?: ImageGeometry;
}

export interface SceneNode {
    name: string;
    node_type: string;
    geometry: NodeGeometry;
    style: NodeStyle;
    visible: boolean;
    locked: boolean;
    /** True when this node masks the siblings painted above it in its group. */
    is_mask?: boolean;
    /** Mask coverage source: 0 = alpha (default), 1 = luminance (reserved). */
    mask_type?: number;
    /** Reserved: clip descendants to this node's bounds (frames — not yet wired). */
    clip_content?: boolean;
    children?: number[];
    /**
     * Local transform, in decomposed components — the engine's `Transform2D`,
     * which is what `get_scene_json` actually serializes.
     *
     * NOT a matrix: indexing it gives `undefined`. For the row-major 3×3 the
     * geometry code wants, ask the scene (`getTransform` for world,
     * `getNodeLocalTransform` for local).
     */
    transform: Transform2D;
}

/** Top-level scene data returned by Engine.get_scene_json(). */
export interface SceneData {
    nodes: Record<number, SceneNode>;
    root_nodes: number[];
}

/** A named, resizable artboard (frame) on the canvas. Mirrors engine Artboard. */
export interface Artboard {
    id: number;
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
    background: Color;
}

/** Pen-tool path point with flat control-point fields. */
export interface PenPathPoint {
    x: number;
    y: number;
    cp1x: number;
    cp1y: number;
    cp2x: number;
    cp2y: number;
    /** Preserved parametric corner radius when the point was adopted from an
     *  existing path (endpoint continuation). Undefined for freshly placed points. */
    corner_radius?: number;
}
