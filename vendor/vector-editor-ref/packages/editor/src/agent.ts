/**
 * Agent authoring API — the surface an autonomous agent drives the editor
 * through (see `EditorHandle.agent`, and the MCP server in `tools/mcp`).
 *
 * The design goal is that an agent works at the level of a human's *intent*
 * ("draw a rect", "align these left", "make it red") rather than a human's
 * *motor actions* (move mouse to 412,90; press; drag). Pixel-driving the real
 * toolbar would be slow, brittle against UI changes, and agents are poor at
 * precise dragging. What actually matters from "a human in front of the tool"
 * is the feedback loop — act, look, correct — so this API is paired with
 * `describe()` and SVG/PNG rendering so the agent can see what it made.
 *
 * Two invariants make agent edits indistinguishable from human ones:
 *
 *   1. Every mutating call goes through `scene.transaction()`, so one agent
 *      call is exactly one undo step. A human can undo an agent's work.
 *   2. Nothing here talks to the engine directly — it all delegates to the
 *      existing `WasmScene` wrappers, so autosave, cache invalidation, mesh
 *      re-snapping and the host's `onDocumentMutated` hook all still fire.
 *
 * Coordinates are world units. Colors are CSS hex (`#rgb`/`#rrggbb`/
 * `#rrggbbaa`) because that is what agents reliably produce; they are parsed
 * to the engine's 0–1 RGBA at the boundary.
 */

import type { CanvasKit } from 'canvaskit-wasm';
import { type AlignMode, alignSelection, distributeSelection } from './align';
import { applyBooleanOp, type BoolOp } from './boolean_ops';
import { colorToHex, parseHex } from './color_picker';
import { DEFAULT_TEXT_FONT } from './fonts';
import { parseSVGPathD } from './svg_utils';
import type {
    Color,
    Gradient,
    NodeGeometry,
    NodeStyle,
    Paint,
    Stroke,
    Subpath,
    TextGeometry,
} from './types';
import { isGradient, isMeshGradient, isSolid, StrokeAlignment } from './types';
import type { WasmScene } from './wasm_scene';

/** A node as reported to the agent: flat, small, and free of engine internals. */
export interface AgentNode {
    id: number;
    name: string;
    type: string;
    /** World-space bounds [x, y, width, height], rounded to 2dp. */
    bounds: [number, number, number, number];
    /** First solid fill as hex, or null when unfilled / gradient / mesh / pattern. */
    fill: string | null;
    /** First solid stroke as hex, or null when unstroked / non-solid. */
    stroke: string | null;
    strokeWidth: number | null;
    /** Non-solid fills report their kind here, since `fill` can't carry them. */
    fillType?: 'gradient' | 'pattern' | 'mesh';
    opacity: number;
    /** Rotation in degrees, so an agent can see a transform it applied. */
    rotation: number;
    visible: boolean;
    locked: boolean;
    children?: AgentNode[];
}

/**
 * The artboard — the frame the artwork is composed within and exported to.
 * Without this an agent has no way to know how big the canvas is, and can't
 * centre anything or reason about margins; it ends up guessing from whatever
 * the first render happened to look like.
 */
export interface AgentCanvas {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Background as hex, or null when transparent. */
    background: string | null;
}

export interface AgentDescription {
    canvas: AgentCanvas | null;
    nodes: AgentNode[];
    /** Ids currently selected in the editor. */
    selection: number[];
}

/**
 * A gradient in the terms an agent thinks in: colour stops plus a direction.
 * The engine stores gradient endpoints in the node's own centred local space,
 * which an agent has no way to reason about — so `angle` is resolved against
 * the node's bounding box at apply time instead.
 */
export interface AgentGradient {
    type: 'linear' | 'radial';
    /** Colour stops; `offset` runs 0 (start) → 1 (end). */
    stops: { offset: number; color: string }[];
    /** Linear only. Degrees: 0 = left→right, 90 = top→bottom. Default 90. */
    angle?: number;
}

export interface AgentApi {
    // ─── Seeing ────────────────────────────────────────────────────────
    /**
     * The whole scene as a compact tree. This is what lets the agent aim.
     *
     * Async because text bounds are only real once the font is loaded, and an
     * agent's loop is create-then-describe with no pause between — describing
     * too early would report estimated widths and silently mislead any layout
     * built on them.
     */
    describe(): Promise<AgentDescription>;
    /** One node, or null if the id is unknown. */
    describeNode(id: number): Promise<AgentNode | null>;
    /** The active document serialized to SVG (for rendering / inspection). */
    toSVG(): string;
    /**
     * The artboard rasterized to a base64 PNG, at `scale` pixels per world
     * unit. Rendered by CanvasKit through the editor's own export path, so it
     * carries no editor chrome and is identical whichever transport an agent
     * reached the editor through.
     */
    toPNG(scale?: number): Promise<string>;

    // ─── Creating ──────────────────────────────────────────────────────
    createRect(x: number, y: number, w: number, h: number, style?: AgentStyle): number;
    createEllipse(cx: number, cy: number, rx: number, ry: number, style?: AgentStyle): number;
    createPolygon(
        cx: number,
        cy: number,
        radius: number,
        sides: number,
        style?: AgentStyle,
    ): number;
    createStar(
        cx: number,
        cy: number,
        outerR: number,
        innerR: number,
        points: number,
        style?: AgentStyle,
    ): number;
    /** A path from explicit points; `points` matches the engine's pen format. */
    createPath(points: AgentPathPoint[], closed?: boolean, style?: AgentStyle): number;
    /**
     * A path from an SVG `d` attribute — the notation agents are most fluent
     * in, and the only practical way to express arcs and smooth curves without
     * hand-computing control points.
     */
    createPathData(d: string, style?: AgentStyle): number;
    createText(
        x: number,
        y: number,
        content: string,
        fontSize?: number,
        style?: AgentStyle,
    ): number;
    /**
     * Import an SVG document, returning the ids of the roots it created.
     * This is the fastest route to complex artwork: compose it as SVG, bring
     * it in, then refine with the verbs above. Goes through the editor's real
     * importer, so gradients, groups and transforms all survive.
     */
    importSVG(svg: string): Promise<number[]>;

    // ─── Styling ───────────────────────────────────────────────────────
    setFill(ids: number | number[], hex: string | null): void;
    /** Fill with a gradient. Replaces any solid fill. */
    setGradient(ids: number | number[], gradient: AgentGradient): void;
    setStroke(ids: number | number[], hex: string | null, width?: number): void;
    setOpacity(ids: number | number[], opacity: number): void;
    setCornerRadius(ids: number | number[], radius: number): void;
    /** Edit a text node's content and/or typography. Only supplied keys change. */
    setText(id: number, opts: AgentTextOptions): void;

    // ─── Arranging ─────────────────────────────────────────────────────
    move(ids: number | number[], dx: number, dy: number): void;
    /** Move a node so the top-left of its bounds — what `describe` reports —
     *  lands on (x, y). */
    setPosition(id: number, x: number, y: number): void;
    resize(id: number, w: number, h: number): void;
    rotate(id: number, degrees: number): void;
    align(ids: number[], mode: AlignMode): void;
    distribute(ids: number[], axis: 'h' | 'v'): void;
    /** Paint order: front = on top of everything, back = behind everything. */
    bringToFront(id: number): void;
    sendToBack(id: number): void;
    /**
     * Resize / recolour the artboard. An icon usually wants a square canvas
     * sized to the artwork, which is otherwise impossible to arrange.
     */
    setCanvas(opts: { width?: number; height?: number; background?: string | null }): void;
    /** Fit the artboard snugly around all artwork, with an optional margin. */
    fitCanvasToArtwork(margin?: number): void;

    // ─── Structuring ───────────────────────────────────────────────────
    group(ids: number[]): number;
    ungroup(id: number): void;
    duplicate(id: number): number;
    remove(ids: number | number[]): void;
    rename(id: number, name: string): void;
    boolean(ids: number[], op: BoolOp): number | null;
    /**
     * Delete everything, in one undo step. An agent that has painted itself
     * into a corner needs a way back to a blank canvas that isn't N deletes.
     */
    clear(): void;

    // ─── Session ───────────────────────────────────────────────────────
    select(ids: number | number[]): void;
    undo(): void;
    redo(): void;
}

/** Style shorthand accepted at creation time, applied in the same undo step. */
export interface AgentStyle {
    fill?: string | null;
    stroke?: string | null;
    strokeWidth?: number;
    opacity?: number;
    cornerRadius?: number;
}

/** Typography edits. Every key is optional; unsupplied ones keep their value. */
export interface AgentTextOptions {
    text?: string;
    fontSize?: number;
    fontFamily?: string;
    align?: 'left' | 'center' | 'right';
    /** CSS-style numeric weight, 100–900 (400 normal, 700 bold). */
    weight?: number;
    italic?: boolean;
    letterSpacing?: number;
    lineHeight?: number;
}

/** A path point; control points default to the anchor (i.e. a straight corner). */
export interface AgentPathPoint {
    x: number;
    y: number;
    cp1x?: number;
    cp1y?: number;
    cp2x?: number;
    cp2y?: number;
}

/** Minimal view of the editor the agent API needs; keeps this module testable. */
export interface AgentDeps {
    scene: WasmScene;
    ck: CanvasKit;
    /** Read the current selection (from the UI engine). */
    getSelection(): number[];
    /** Replace the current selection (drives the UI engine + a re-render). */
    setSelection(ids: number[]): void;
    /** Serialize the active document to SVG. */
    exportSVG(): string;
    /**
     * Rasterize the artboard to a base64 PNG at `scale` px per world unit.
     * Lives on the host because it needs the renderer's offscreen export
     * surface, which this module deliberately doesn't depend on.
     */
    renderPNG(scale: number): Promise<string>;
    /**
     * Start loading a font family's faces, so a subsequent render has them.
     * Fire-and-forget: creation stays synchronous, and `renderPNG` is what
     * waits.
     */
    ensureFont(family: string): void;
    /**
     * True typeset size of a text node, or null if it can't be measured yet.
     * The engine's own text bounds are a crude estimate, which is fine for
     * hit-testing but wrong for anything that positions text by its width.
     */
    measureText(geo: TextGeometry): { width: number; height: number; baseline?: number } | null;
    /** Resolve once no font load is in flight, so text can be measured. */
    fontsReady(): Promise<void>;
    /**
     * Import an SVG document, resolving to the new root ids. Lives on the UI
     * engine (it needs DOM parsing plus raster fallbacks), which this module
     * deliberately doesn't depend on directly.
     */
    importSVG(svg: string): Promise<number[]>;
}

function toIds(ids: number | number[]): number[] {
    return typeof ids === 'number' ? [ids] : ids;
}

function requireColor(hex: string): Color {
    const c = parseHex(hex);
    if (!c) throw new Error(`[agent] invalid color ${JSON.stringify(hex)} — expected CSS hex`);
    return c;
}

/** First solid paint in a list as hex, or null when empty/non-solid. */
function firstSolidHex(paints: Paint[] | undefined): string | null {
    const p = paints?.[0];
    if (!p || !isSolid(p)) return null;
    return colorToHex(p);
}

/** Report what a non-solid fill actually is, so `fill: null` isn't ambiguous. */
function paintKind(paints: Paint[] | undefined): AgentNode['fillType'] {
    const p = paints?.[0];
    if (!p || isSolid(p)) return undefined;
    if (isGradient(p)) return 'gradient';
    if (isMeshGradient(p)) return 'mesh';
    return 'pattern';
}

/**
 * A node's bounding box in its OWN local space, as [minX, minY, maxX, maxY].
 *
 * Local space is not uniform across node types, which is the trap here: a Rect
 * has its origin at the top-left and spans 0..w, while an Ellipse and a Path
 * are centred on the origin and span -w/2..w/2. Assuming "centred" everywhere
 * puts a gradient's endpoints outside a Rect entirely, so most of the shape
 * falls beyond the last stop and pads to a flat colour — it still reports as a
 * gradient fill, it just doesn't look like one.
 */
function localBox(
    node: { node_type: string; geometry: NodeGeometry },
    measure?: (geo: TextGeometry) => { width: number; height: number } | null,
): [number, number, number, number] {
    const { geometry: geo } = node;
    if (geo.Rect) return [0, 0, geo.Rect.width, geo.Rect.height];
    if (geo.Image) return [0, 0, geo.Image.width, geo.Image.height];
    if (geo.Ellipse) {
        const { radius_x: rx, radius_y: ry } = geo.Ellipse;
        return [-rx, -ry, rx, ry];
    }
    if (geo.Path) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const sp of geo.Path.subpaths) {
            for (const pt of sp.points) {
                // Control points can extend a curve beyond its anchors.
                for (const [x, y] of [[pt.x, pt.y], pt.cp1, pt.cp2] as [number, number][]) {
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                }
            }
        }
        if (Number.isFinite(minX)) return [minX, minY, maxX, maxY];
    }
    if (geo.Text) {
        // Text carries no stored box, so a gradient across it needs the typeset
        // size. Fall back to a font-size estimate only if measuring fails.
        const m = measure?.(geo.Text);
        if (m) return [0, -m.height, m.width, 0];
        const size = geo.Text.font_size;
        return [0, -size, size * Math.max(geo.Text.content.length, 1) * 0.6, 0];
    }
    return [0, 0, 0, 0];
}

/**
 * Resolve an agent-facing gradient onto a node's local box.
 *
 * The engine stores endpoints in the node's own local space, which an agent has
 * no way to reason about — so it supplies an angle, and this projects that
 * angle across the box supplied by `localBox`.
 */
function buildGradient(g: AgentGradient, box: [number, number, number, number]): Gradient {
    const stops = g.stops
        .map((s) => ({ offset: s.offset, color: requireColor(s.color) }))
        .sort((a, b) => a.offset - b.offset);
    if (stops.length < 2) throw new Error('[agent] a gradient needs at least 2 stops');

    const [minX, minY, maxX, maxY] = box;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const hw = Math.max((maxX - minX) / 2, 0.5);
    const hh = Math.max((maxY - minY) / 2, 0.5);

    if (g.type === 'radial') {
        // Concentric on the box centre, sized to cover its longer half-axis.
        return {
            gradient_type: 'Radial',
            stops,
            start_x: cx,
            start_y: cy,
            end_x: cx + Math.max(hw, hh),
            end_y: cy,
        };
    }
    // Linear: a line through the box centre at `angle`, reaching its edges.
    // Snap to 4dp: cos(90°) is 6e-17 rather than 0, which would otherwise ship
    // endpoints like "-1.7145055e-14" into every exported SVG.
    const rad = ((g.angle ?? 90) * Math.PI) / 180;
    const snap = (n: number) => Math.round(n * 1e4) / 1e4;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    return {
        gradient_type: 'Linear',
        stops,
        start_x: snap(cx - dx * hw),
        start_y: snap(cy - dy * hh),
        end_x: snap(cx + dx * hw),
        end_y: snap(cy + dy * hh),
    };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Build a stroke, preserving whatever the node already had (cap, join, dashes)
 * and overriding only paint/width. A width set with no colour and no existing
 * stroke has nothing to paint, so it defaults to black — otherwise the agent
 * would make a change it can't see, and would loop trying to fix it.
 */
function makeStroke(
    existing: Stroke | undefined,
    paint: Paint | undefined,
    width?: number,
): Stroke {
    return {
        cap: existing?.cap ?? 0,
        join: existing?.join ?? 0,
        dash_array: existing?.dash_array ?? [],
        dash_offset: existing?.dash_offset ?? 0,
        miter_limit: existing?.miter_limit ?? 4,
        alignment: existing?.alignment ?? StrokeAlignment.Center,
        paint: paint ?? existing?.paint ?? { r: 0, g: 0, b: 0, a: 1 },
        width: width ?? existing?.width ?? 1,
    };
}

/**
 * The engine's default node style carries a black 2px stroke, which is right
 * for a human dragging out a shape on a canvas (they can see it and delete it)
 * but wrong for an agent: asking for "a yellow circle" would silently produce
 * a black-outlined one, and a thin dark outline is exactly the sort of detail
 * an agent won't notice in a render and will never think to remove. So at
 * creation time a stroke is opt-in — unless the caller mentioned `stroke` or
 * `strokeWidth`, we clear it.
 */
function creationStyle(style: AgentStyle | undefined): AgentStyle {
    if (style?.stroke !== undefined || style?.strokeWidth !== undefined) return style;
    return { ...style, stroke: null };
}

export function createAgentApi(deps: AgentDeps): AgentApi {
    const { scene, ck } = deps;

    /**
     * Resolve ids, failing loudly on unknown ones. Without this, a stale id
     * reaches `getNodeStyle`, whose `JSON.parse` of the engine's empty string
     * surfaces as "Unexpected end of JSON input" — a message that tells an
     * agent nothing about what it did wrong or how to recover.
     */
    const requireNodes = (ids: number | number[]): number[] => {
        const list = toIds(ids);
        const missing = list.filter((id) => scene.getNode(id) === null);
        if (missing.length) {
            throw new Error(
                `[agent] no object with id ${missing.join(', ')} — call describe() for current ids`,
            );
        }
        return list;
    };

    /** Apply an `AgentStyle` to a node without its own history push — callers
     *  are always already inside a transaction that owns the undo step. */
    const applyStyle = (id: number, style: AgentStyle | undefined) => {
        if (!style) return;
        const current = scene.getNodeStyle(id);
        if (!current) return; // node gone — nothing to restyle
        const next: NodeStyle = { ...current };
        if (style.fill !== undefined) {
            next.fills = style.fill === null ? [] : [requireColor(style.fill)];
        }
        if (style.stroke !== undefined || style.strokeWidth !== undefined) {
            const existing = current.strokes?.[0];
            if (style.stroke === null) {
                next.strokes = [];
            } else {
                const paint = style.stroke !== undefined ? requireColor(style.stroke) : undefined;
                next.strokes = [makeStroke(existing, paint, style.strokeWidth)];
            }
        }
        if (style.opacity !== undefined) next.opacity = style.opacity;
        if (style.cornerRadius !== undefined) next.corner_radius = style.cornerRadius;
        scene.setNodeStyleNoHistory(id, JSON.stringify(next));
    };

    /** Read-modify-write a node's style inside the caller's transaction. */
    const editStyle = (ids: number | number[], edit: (s: NodeStyle) => NodeStyle) => {
        const list = requireNodes(ids);
        scene.transaction(() => {
            for (const id of list) {
                const current = scene.getNodeStyle(id);
                if (!current) continue;
                scene.setNodeStyleNoHistory(id, JSON.stringify(edit({ ...current })));
            }
        });
    };

    /** The primary artboard, which is the frame `exportSVG` renders. */
    const describeCanvas = (): AgentCanvas | null => {
        const ab = scene.getArtboards()[0];
        if (!ab) return null;
        return {
            x: ab.x,
            y: ab.y,
            width: ab.w,
            height: ab.h,
            background: ab.background && ab.background.a > 0 ? colorToHex(ab.background) : null,
        };
    };

    /**
     * A node's world bounds as [minX, minY, maxX, maxY], with text measured
     * rather than estimated.
     *
     * The engine's own bounds approximate text as `bytes * font_size * 0.6`, so
     * anything reading them frames text wrongly — a fitted canvas clips a
     * wordmark, a reported width misplaces an alignment. Groups are walked
     * rather than trusted, because a group's engine bounds are the union of
     * those same estimates.
     */
    const worldBounds = (id: number): [number, number, number, number] | null => {
        const node = scene.getNode(id);
        if (!node) return null;

        // A Boolean Group is the exception to walking a group: it paints ONE
        // resolved outline and never its operands, so unioning the children
        // would report geometry that isn't drawn. Its engine bounds are that
        // outline, and no text estimate can be involved — a boolean result is a
        // path.
        if (scene.isBooleanGroup(id)) {
            const bb = scene.getNodeBounds(id);
            return [bb[0], bb[1], bb[2], bb[3]];
        }

        const kids = node.children ?? [];
        if (kids.length) {
            let box: [number, number, number, number] | null = null;
            for (const childId of kids) {
                const cb = worldBounds(childId);
                if (!cb) continue;
                box = box
                    ? [
                          Math.min(box[0], cb[0]),
                          Math.min(box[1], cb[1]),
                          Math.max(box[2], cb[2]),
                          Math.max(box[3], cb[3]),
                      ]
                    : cb;
            }
            if (box) return box;
        }

        const b = scene.getNodeBounds(id);
        const text = node.geometry.Text;
        if (!text) return [b[0], b[1], b[2], b[3]];
        const measured = deps.measureText(text);
        if (!measured) return [b[0], b[1], b[2], b[3]];
        // measureText returns the typeset size in the node's OWN local units,
        // while x/y are world. Scale it by the world transform, or text under a
        // scaled group claims a size it doesn't occupy.
        const t = scene.getTransform(id);
        const sx = Math.hypot(t[0], t[3]);
        const sy = Math.hypot(t[1], t[4]);
        return [b[0], b[1], b[0] + measured.width * sx, b[1] + measured.height * sy];
    };

    /** Union of every root node's world bounds, or null on an empty canvas. */
    const artworkBounds = (): [number, number, number, number] | null => {
        let box: [number, number, number, number] | null = null;
        for (const id of Array.from(scene.getRootNodes())) {
            const b = worldBounds(id);
            if (!b) continue;
            box = box
                ? [
                      Math.min(box[0], b[0]),
                      Math.min(box[1], b[1]),
                      Math.max(box[2], b[2]),
                      Math.max(box[3], b[3]),
                  ]
                : b;
        }
        return box;
    };

    const describeNodeSync = (id: number): AgentNode | null => {
        const node = scene.getNode(id);
        if (!node) return null;
        // Same measured bounds everything else uses, so a width read here and a
        // canvas fitted there can never disagree about where a shape ends.
        const b = worldBounds(id) ?? scene.getNodeBounds(id);
        const stroke = node.style.strokes?.[0];
        const width = round2(b[2] - b[0]);
        const height = round2(b[3] - b[1]);
        const out: AgentNode = {
            id,
            name: node.name,
            type: node.node_type,
            bounds: [round2(b[0]), round2(b[1]), width, height],
            fill: firstSolidHex(node.style.fills),
            fillType: paintKind(node.style.fills),
            stroke: stroke?.paint && isSolid(stroke.paint) ? colorToHex(stroke.paint) : null,
            strokeWidth: stroke ? stroke.width : null,
            opacity: node.style.opacity,
            rotation: round2(scene.getNodeTransformComponents(id).rotation_deg),
            visible: node.visible,
            locked: node.locked,
        };
        const kids = node.children ?? [];
        if (kids.length) {
            out.children = kids
                .map((childId) => describeNodeSync(childId))
                .filter((n): n is AgentNode => n !== null);
        }
        return out;
    };

    return {
        async describe(): Promise<AgentDescription> {
            await deps.fontsReady();
            const data = scene.getSceneData();
            return {
                canvas: describeCanvas(),
                nodes: data.root_nodes
                    .map((id) => describeNodeSync(id))
                    .filter((n): n is AgentNode => n !== null),
                selection: deps.getSelection(),
            };
        },

        async describeNode(id: number) {
            await deps.fontsReady();
            return describeNodeSync(id);
        },

        toSVG: () => deps.exportSVG(),

        toPNG: (scale = 2) => deps.renderPNG(scale),

        createRect(x, y, w, h, style) {
            return scene.transaction(() => {
                const id = scene.addRect(x, y, w, h);
                applyStyle(id, creationStyle(style));
                return id;
            });
        },

        createEllipse(cx, cy, rx, ry, style) {
            return scene.transaction(() => {
                const id = scene.addEllipse(cx, cy, rx, ry);
                applyStyle(id, creationStyle(style));
                return id;
            });
        },

        createPolygon(cx, cy, radius, sides, style) {
            return scene.transaction(() => {
                const id = scene.addPolygon(cx, cy, radius, sides);
                applyStyle(id, creationStyle(style));
                return id;
            });
        },

        createStar(cx, cy, outerR, innerR, points, style) {
            return scene.transaction(() => {
                const id = scene.addStar(cx, cy, outerR, innerR, points);
                applyStyle(id, creationStyle(style));
                return id;
            });
        },

        createPath(points, closed = false, style) {
            if (points.length < 2) throw new Error('[agent] createPath needs at least 2 points');
            // The engine's path format carries explicit control points as
            // [x, y] tuples; an agent that omits them means "straight segment",
            // which is cp == anchor. Note the engine's `add_path` deserializes
            // with `unwrap_or_default()`, so a shape mismatch here yields a
            // silently EMPTY path rather than an error — hence the typed
            // Subpath below rather than an inline object literal.
            const subpath: Subpath = {
                closed,
                points: points.map((p) => ({
                    x: p.x,
                    y: p.y,
                    cp1: [p.cp1x ?? p.x, p.cp1y ?? p.y],
                    cp2: [p.cp2x ?? p.x, p.cp2y ?? p.y],
                })),
            };
            return scene.transaction(() => {
                const id = scene.addPath(JSON.stringify([subpath]));
                applyStyle(id, creationStyle(style));
                return id;
            });
        },

        createPathData(d, style) {
            // parseSVGPathD already emits the engine's [x,y] control-point
            // tuples, so this needs no conversion — and it handles arcs and
            // smooth-curve shorthand, which the point form can't express.
            const subpaths = parseSVGPathD(d, 0, 0);
            if (!subpaths.length || !subpaths.some((sp) => sp.points.length >= 2)) {
                throw new Error(
                    `[agent] path data produced no drawable geometry: ${d.slice(0, 60)}`,
                );
            }
            return scene.transaction(() => {
                const id = scene.addPath(JSON.stringify(subpaths));
                applyStyle(id, creationStyle(style));
                return id;
            });
        },

        createText(x, y, content, fontSize = 16, style) {
            // The engine creates text with an EMPTY family, which falls back to
            // CanvasKit's RefDefault — not a sans-serif, and with no bold or
            // italic face to select, so weight and slant silently do nothing.
            // The text tool assigns a real family for exactly this reason; do
            // the same, and start the fetch so a render can wait on it.
            deps.ensureFont(DEFAULT_TEXT_FONT);
            return scene.transaction(() => {
                const id = scene.addText(x, y, content, fontSize);
                scene.setTextPropertiesNoHistory(id, DEFAULT_TEXT_FONT, 0, 1.2);
                // The engine defaults text to a WHITE fill, which is invisible
                // on the default white artboard — the agent gets a node that
                // reports fine and draws nothing, with no way to diagnose it.
                // Default to black; an explicit fill still wins.
                applyStyle(id, { fill: '#000000', ...creationStyle(style) });
                return id;
            });
        },

        async importSVG(svg) {
            if (!/<svg[\s>]/i.test(svg)) {
                throw new Error('[agent] importSVG expects an <svg> document');
            }
            return deps.importSVG(svg);
        },

        setFill(ids, hex) {
            const fills: Paint[] = hex === null ? [] : [requireColor(hex)];
            editStyle(ids, (s) => ({ ...s, fills }));
        },

        setStroke(ids, hex, width) {
            editStyle(ids, (s) => {
                if (hex === null) return { ...s, strokes: [] };
                return { ...s, strokes: [makeStroke(s.strokes?.[0], requireColor(hex), width)] };
            });
        },

        setGradient(ids, gradient) {
            // Endpoints are per-node (they're resolved against each node's own
            // box), so this can't share one paint across the batch.
            const list = requireNodes(ids);
            scene.transaction(() => {
                for (const id of list) {
                    const node = scene.getNode(id);
                    if (!node) continue;
                    const paint = buildGradient(gradient, localBox(node, deps.measureText));
                    scene.setNodeStyleNoHistory(
                        id,
                        JSON.stringify({ ...node.style, fills: [paint] }),
                    );
                }
            });
        },

        setOpacity(ids, opacity) {
            editStyle(ids, (s) => ({ ...s, opacity }));
        },

        setText(id, opts) {
            requireNodes(id);
            const node = scene.getNode(id);
            if (node?.node_type !== 'Text') {
                throw new Error(
                    `[agent] node ${id} is a ${node?.node_type ?? 'unknown'}, not Text`,
                );
            }
            const t = node.geometry.Text;
            if (!t) throw new Error(`[agent] node ${id} has no text geometry`);
            const ALIGN = { left: 0, center: 1, right: 2 } as const;
            // Switching family, or asking for a weight/slant this family hasn't
            // fetched yet, needs the faces on hand before the next render.
            if (opts.fontFamily) deps.ensureFont(opts.fontFamily);
            scene.transaction(() => {
                if (opts.text !== undefined || opts.fontSize !== undefined) {
                    scene.setTextContent(id, opts.text ?? t.content, opts.fontSize ?? t.font_size);
                }
                if (
                    opts.fontFamily !== undefined ||
                    opts.align !== undefined ||
                    opts.lineHeight !== undefined
                ) {
                    scene.setTextProperties(
                        id,
                        opts.fontFamily ?? t.font_family,
                        opts.align !== undefined ? ALIGN[opts.align] : t.text_align,
                        opts.lineHeight ?? t.line_height,
                    );
                }
                if (
                    opts.weight !== undefined ||
                    opts.italic !== undefined ||
                    opts.letterSpacing !== undefined
                ) {
                    scene.setTextStyle(
                        id,
                        opts.weight ?? t.font_weight ?? 400,
                        opts.italic ?? t.italic ?? false,
                        opts.letterSpacing ?? t.letter_spacing ?? 0,
                    );
                }
            });
        },

        setCornerRadius(ids, radius) {
            editStyle(ids, (s) => ({ ...s, corner_radius: radius }));
        },

        // The whole API speaks world units — that is what describe_scene
        // reports and what the canvas shows. These three used to write local
        // ones straight through, so inside any group carrying a transform (an
        // imported SVG's, or a group that has been resized) a move went the
        // wrong distance and a resize came out the wrong size.
        move(ids, dx, dy) {
            const list = requireNodes(ids);
            scene.transaction(() => {
                for (const id of list) scene.moveNodeWorld(id, dx, dy);
            });
        },

        setPosition(id, x, y) {
            requireNodes(id);
            scene.transaction(() => {
                // (x, y) is the TOP-LEFT of the shape — the same corner
                // `describe` reports and the editor's own X/Y fields set. It
                // used to be the node's transform origin, which is the top-left
                // only for a rectangle: feeding an ellipse or a star back the
                // position just read for it shoved it half its own size across
                // the canvas, and any layout computed from `describe` landed
                // off by that much.
                const b = worldBounds(id) ?? scene.getNodeBounds(id);
                scene.moveNodeWorld(id, x - b[0], y - b[1]);
            });
        },

        resize(id, w, h) {
            requireNodes(id);
            // Text is auto-width: `resize_node` is a no-op for it, so asking to
            // resize a text node did nothing at all and said nothing about it.
            // Scale the type instead, the way dragging its handles does — the
            // result is as close to the box as a line of text can be.
            const text = scene.getNodeGeometry(id)?.Text;
            if (text) {
                const b = worldBounds(id) ?? scene.getNodeBounds(id);
                const curW = Math.max(b[2] - b[0], 1e-6);
                const curH = Math.max(b[3] - b[1], 1e-6);
                const k = Math.sqrt((w / curW) * (h / curH));
                const size = Math.max(1, Math.min(2000, text.font_size * k));
                scene.transaction(() => scene.setTextContent(id, text.content, size));
                return;
            }
            // A group is sized in world units by the engine; a leaf's geometry
            // is written in its own space.
            const size = scene.getNodeType(id) === 3 ? { w, h } : scene.worldSizeToLocal(id, w, h);
            scene.transaction(() => scene.resizeNode(id, size.w, size.h));
        },

        rotate(id, degrees) {
            requireNodes(id);
            scene.transaction(() => scene.setNodeRotation(id, degrees));
        },

        align(ids, mode) {
            requireNodes(ids);
            scene.transaction(() => alignSelection(scene, ids, mode));
        },

        distribute(ids, axis) {
            requireNodes(ids);
            scene.transaction(() => distributeSelection(scene, ids, axis));
        },

        bringToFront(id) {
            requireNodes(id);
            scene.transaction(() => scene.bringToFront(id));
        },

        sendToBack(id) {
            requireNodes(id);
            scene.transaction(() => scene.sendToBack(id));
        },

        setCanvas(opts) {
            const ab = scene.getArtboards()[0];
            if (!ab) throw new Error('[agent] this document has no artboard');
            scene.transaction(() => {
                if (opts.width !== undefined || opts.height !== undefined) {
                    scene.setArtboardBounds(
                        ab.id,
                        ab.x,
                        ab.y,
                        opts.width ?? ab.w,
                        opts.height ?? ab.h,
                    );
                }
                if (opts.background !== undefined) {
                    const c =
                        opts.background === null
                            ? { r: 0, g: 0, b: 0, a: 0 }
                            : requireColor(opts.background);
                    scene.setArtboardBackground(ab.id, c.r, c.g, c.b, c.a);
                }
            });
        },

        fitCanvasToArtwork(margin = 0) {
            const ab = scene.getArtboards()[0];
            if (!ab) throw new Error('[agent] this document has no artboard');
            const bounds = artworkBounds();
            if (!bounds) throw new Error('[agent] nothing to fit — the canvas is empty');
            const [minX, minY, maxX, maxY] = bounds;
            scene.transaction(() =>
                scene.setArtboardBounds(
                    ab.id,
                    minX - margin,
                    minY - margin,
                    maxX - minX + margin * 2,
                    maxY - minY + margin * 2,
                ),
            );
        },

        group(ids) {
            requireNodes(ids);
            return scene.transaction(() => scene.groupNodes(ids));
        },

        ungroup(id) {
            requireNodes(id);
            scene.transaction(() => scene.ungroupNode(id));
        },

        duplicate(id) {
            requireNodes(id);
            return scene.transaction(() => {
                const copy = scene.duplicateNode(id);
                // A copy belongs where its original lives, not at the root.
                scene.fileCopyBesideOriginal(copy, id);
                return copy;
            });
        },

        remove(ids) {
            const list = requireNodes(ids);
            scene.transaction(() => scene.removeNodes(list));
        },

        rename(id, name) {
            requireNodes(id);
            scene.transaction(() => scene.setNodeName(id, name));
        },

        clear() {
            const roots = Array.from(scene.getRootNodes());
            if (!roots.length) return;
            scene.transaction(() => scene.removeNodes(roots));
        },

        boolean(ids, op) {
            if (ids.length < 2) throw new Error('[agent] boolean needs at least 2 nodes');
            requireNodes(ids);
            return scene.transaction(() => applyBooleanOp(ck, scene, ids, op));
        },

        select(ids) {
            deps.setSelection(requireNodes(ids));
        },

        undo: () => scene.undo(),
        redo: () => scene.redo(),
    };
}
