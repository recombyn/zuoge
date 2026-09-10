/**
 * Pure SVG export module.
 * Converts scene data to an SVG document string without requiring WasmScene or UIEngine.
 * This separation enables testing without WASM and reuse in other contexts.
 */

import { meanColor, meshContentHash } from './mesh_geom';
import {
    composeMatrices,
    escapeXml,
    identityMatrix,
    invertMatrix,
    isIdentityMatrix,
    matrixToSVGTransform,
    rgbToHex,
} from './svg_utils';
import type { NodeStyle, Paint, SceneNode } from './types';
import { isGradient, isMeshGradient, isPattern, isSolid } from './types';

// ─── Lookup Tables ──────────────────────────────────────────────────────────

/**
 * `data-rcb-vector-role` value marking the canvas background rect an export paints
 * behind the artwork.
 *
 * It exists so import can tell "this is the page" from "this is a shape the
 * user drew". Without it, opening our own SVG turns the background into a real
 * full-canvas rectangle in the layer list — and doing it twice gives two.
 * Plain `data-*`, so every other SVG renderer simply ignores it.
 */
export const CANVAS_BACKGROUND_ROLE = 'canvas-background';

const CAP_MAP = ['butt', 'round', 'square'] as const;
const JOIN_MAP = ['miter', 'round', 'bevel'] as const;
const FILL_RULE_MAP = ['nonzero', 'evenodd'] as const;

export const BLEND_MODE_MAP = [
    'normal',
    'multiply',
    'screen',
    'overlay',
    'darken',
    'lighten',
    'color-dodge',
    'color-burn',
    'hard-light',
    'soft-light',
    'difference',
    'exclusion',
    'hue',
    'saturation',
    'color',
    'luminosity',
] as const;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Filled face data from the engine's vector network. */
export interface FilledFace {
    id: number;
    boundary: [number, number][];
    /** Exact-bézier outline (anchor + handles); preferred over `boundary`. */
    outline?: { x: number; y: number; cp1: number[]; cp2: number[] }[];
    fill: { r: number; g: number; b: number; a: number };
}

type OutlinePt = { x: number; y: number; cp1: number[]; cp2: number[] };
type RGBA = { r: number; g: number; b: number; a: number };

/** A Live Paint face tagged with its owning group, drawn UNDER the group's
 *  member strokes (effective color = painted or inherited). */
export interface LivePaintFace {
    group: number;
    outline?: OutlinePt[];
    boundary?: [number, number][];
    /** Flat fallback colour — always present, even when `paint` is a gradient. */
    fill: RGBA;
    /** The region's actual paint. Absent on data from an older engine. */
    paint?: Paint;
    /** Islands inside this region, exported as holes of the same path. Without
     *  them a region that encloses another exports as a solid slab over it. */
    holes?: OutlinePt[][];
}

/** A painted Live Paint edge, drawn ON TOP of its group's members. */
export interface LivePaintEdge {
    group: number;
    outline: OutlinePt[];
    color: RGBA;
    width: number;
}

/** Per-group Live Paint render data (mirrors the in-app compositing). */
export interface LivePaintRenderData {
    groups: number[];
    faces: LivePaintFace[];
    edges: LivePaintEdge[];
}

/** Input data for the pure SVG export function. */
export interface SVGExportInput {
    /** Document width in pixels. */
    docWidth: number;
    /** Document height in pixels. */
    docHeight: number;
    /** All scene nodes, keyed by ID. */
    nodes: Record<number, SceneNode>;
    /** Ordered root node IDs. */
    rootNodeIds: number[];
    /**
     * Local transform per node ID as column-major [f32; 9].
     * If missing for a node, identity is assumed.
     */
    localTransforms: Record<number, number[]>;
    /** Optional filled faces from the vector network. Legacy: drawn on TOP of the
     *  whole scene. Superseded by `livePaint` when that is present. */
    filledFaces?: FilledFace[];
    /**
     * Optional per-group Live Paint render data. When present, faces render
     * UNDER each group's member strokes (at the group's z), member fills are
     * suppressed, and painted edges render on top — mirroring the in-app
     * compositing. Takes precedence over `filledFaces`.
     */
    livePaint?: LivePaintRenderData;
    /** Optional data-URI per image id (for exporting Image nodes as <image>). */
    imageDataUris?: Record<number, string>;
    /** Text-on-path links: text node id → its path id and that path's outline in
     *  WORLD coordinates (a `d` string). Emits `<textPath>` referencing a def. */
    textPaths?: Record<number, { pathId: number; d: string }>;
    /**
     * Optional export bounds (a specific artboard, or the whole canvas). When
     * given, the SVG viewBox is `x y w h` and width/height are `w×h`; content is
     * emitted in the same world coordinates and cropped by the viewBox.
     */
    viewBox?: { x: number; y: number; w: number; h: number };
    /** Optional solid background rect drawn behind all content. */
    background?: { r: number; g: number; b: number; a: number };
    /**
     * Rasterized mesh-gradient fills keyed by mesh content hash
     * (mesh_geom.meshContentHash): PNG data URI + node-local placement.
     * SVG 1.1 has no mesh gradients, so each becomes a non-repeating
     * userSpaceOnUse <pattern> that the shape's own outline clips. Native
     * saves stay lossless via the embedded binary payload.
     */
    meshRasters?: Record<number, { href: string; x: number; y: number; w: number; h: number }>;
}

// ─── SVG Generation ─────────────────────────────────────────────────────────

/**
 * Build a complete SVG document string from scene data.
 * Gradient defs are collected during rendering and prepended into a <defs> block.
 */
export function buildSVGFromData(input: SVGExportInput): string {
    const {
        docWidth,
        docHeight,
        nodes,
        rootNodeIds,
        localTransforms,
        filledFaces,
        livePaint,
        imageDataUris,
        viewBox,
        background,
        textPaths,
        meshRasters,
    } = input;

    // ─── Live Paint compositing (mirrors the render writer) ──────────────────
    // When per-group render data is present, faces draw under each group's
    // members (member fills suppressed) and painted edges draw on top.
    const lpGroupSet = new Set<number>(livePaint?.groups ?? []);
    const useLivePaintCompositing = lpGroupSet.size > 0;
    const facesByGroup = new Map<number, LivePaintFace[]>();
    const edgesByGroup = new Map<number, LivePaintEdge[]>();
    if (livePaint) {
        for (const f of livePaint.faces) {
            (facesByGroup.get(f.group) ?? facesByGroup.set(f.group, []).get(f.group)!).push(f);
        }
        for (const e of livePaint.edges) {
            (edgesByGroup.get(e.group) ?? edgesByGroup.set(e.group, []).get(e.group)!).push(e);
        }
    }

    /** Build a closed `d` from an exact-bézier outline, else the polygon. */
    const faceToPathD = (
        outline: OutlinePt[] | undefined,
        boundary: [number, number][] | undefined,
    ): string => {
        if (outline && outline.length >= 2) {
            const o = outline;
            let d = `M ${o[0].x} ${o[0].y}`;
            for (let i = 0; i < o.length - 1; i++) {
                const a = o[i],
                    b = o[i + 1];
                d += ` C ${a.cp2[0]} ${a.cp2[1]} ${b.cp1[0]} ${b.cp1[1]} ${b.x} ${b.y}`;
            }
            const a = o[o.length - 1],
                b = o[0];
            d += ` C ${a.cp2[0]} ${a.cp2[1]} ${b.cp1[0]} ${b.cp1[1]} ${b.x} ${b.y} Z`;
            return d;
        }
        return (
            (boundary ?? []).map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ') +
            ' Z'
        );
    };

    /** Build an OPEN `d` from an outline (painted edges are strokes, not filled). */
    const edgeToPathD = (o: OutlinePt[]): string => {
        if (o.length < 2) return '';
        let d = `M ${o[0].x} ${o[0].y}`;
        for (let i = 0; i < o.length - 1; i++) {
            const a = o[i],
                b = o[i + 1];
            d += ` C ${a.cp2[0]} ${a.cp2[1]} ${b.cp1[0]} ${b.cp1[1]} ${b.x} ${b.y}`;
        }
        return d;
    };

    /**
     * Live Paint faces and edges come out of the engine in WORLD coordinates,
     * but they are emitted INSIDE the group's `<g transform=…>` (that is where
     * they belong in z-order). Wrapping them in the inverse of the group's world
     * transform cancels the ancestor chain, so they land where the canvas draws
     * them. Groups carry a translate to their bbox corner, so without this the
     * faces are offset by that much — usually clean off the exported artboard.
     * Returns '' for an identity/degenerate transform (nothing to undo).
     */
    const inverseWrap = (world: number[]): string => {
        const inv = invertMatrix(world);
        if (!inv || isIdentityMatrix(world)) return '';
        return matrixToSVGTransform(inv);
    };

    const wrapWorld = (world: number[], content: string): string => {
        if (!content) return '';
        const t = inverseWrap(world);
        return t ? `<g transform="${t}">${content}</g>` : content;
    };

    const lpFacesSvg = (groupId: number, world: number[]): string => {
        const faces = facesByGroup.get(groupId);
        if (!faces || faces.length === 0) return '';
        return wrapWorld(
            world,
            faces
                .map((f) => {
                    // `paint` (a gradient, say) wins; `fill` is the flat
                    // fallback older engines and simple consumers provide.
                    const value = f.paint ? paintToSvgValue(f.paint) : escapeXml(rgbToHex(f.fill));
                    // A gradient carries its own per-stop alpha; only a solid
                    // needs fill-opacity.
                    const opacity =
                        f.paint && !isSolid(f.paint) ? '' : ` fill-opacity="${f.fill.a}"`;
                    // Islands become extra contours on the same path, filled
                    // even-odd so they read as holes. Winding is the
                    // arrangement's business, not the exporter's, so the rule
                    // that does not depend on it is the right one.
                    const rings = [
                        faceToPathD(f.outline, f.boundary),
                        ...(f.holes ?? []).map((h) => faceToPathD(h, undefined)),
                    ].join(' ');
                    const rule = f.holes && f.holes.length > 0 ? ' fill-rule="evenodd"' : '';
                    return (
                        `<path d="${rings}" fill="${value}"${rule}` + `${opacity} stroke="none" />`
                    );
                })
                .join(''),
        );
    };

    const lpEdgesSvg = (groupId: number, world: number[]): string => {
        const edges = edgesByGroup.get(groupId);
        if (!edges || edges.length === 0) return '';
        return wrapWorld(
            world,
            edges
                .map((e) => {
                    const d = edgeToPathD(e.outline);
                    if (!d) return '';
                    return (
                        `<path d="${d}" fill="none" stroke="${rgbToHex(e.color)}" ` +
                        `stroke-opacity="${e.color.a}" stroke-width="${e.width}" ` +
                        `stroke-linecap="round" stroke-linejoin="round" />`
                    );
                })
                .join(''),
        );
    };

    const vb = viewBox ?? { x: 0, y: 0, w: docWidth, h: docHeight };
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${vb.w}" height="${vb.h}" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}">`;

    // Optional solid background rect (covers the viewBox). It is the canvas,
    // not artwork — tagged so that re-importing our own export doesn't turn the
    // background into a real full-page rectangle, one more on every round trip.
    // Other renderers ignore the attribute and still paint the background.
    if (background && background.a > 0) {
        const c = `rgba(${Math.round(background.r * 255)},${Math.round(background.g * 255)},${Math.round(background.b * 255)},${background.a})`;
        svg += `<rect data-rcb-vector-role="${CANVAS_BACKGROUND_ROLE}" x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="${c}"/>`;
    }

    // Collect gradient <defs> during rendering
    const gradientDefs: string[] = [];
    let gradientIdCounter = 0;

    // Collect <mask> defs (Figma-style is_mask children → SVG alpha masks)
    const maskDefs: string[] = [];
    let maskIdCounter = 0;

    // Collect <filter> defs (blur / drop-shadow effects)
    const filterDefs: string[] = [];
    let filterIdCounter = 0;

    // Collect <pattern> defs (tiled-image pattern fills)
    const patternDefs: string[] = [];
    let patternIdCounter = 0;

    // Collect <path> defs referenced by text-on-path <textPath> elements.
    const textPathDefs: string[] = [];

    /** Build a <filter> def for a node's effects, returning its id (or null). */
    const buildFilterDef = (effects: NonNullable<NodeStyle['effects']>): string | null => {
        if (!effects || effects.length === 0) return null;
        const prims = effects
            .map((eff) => {
                if ('Blur' in eff) {
                    return `<feGaussianBlur stdDeviation="${eff.Blur.radius}" />`;
                }
                if ('ColorMatrix' in eff) {
                    return `<feColorMatrix type="matrix" values="${eff.ColorMatrix.matrix.join(' ')}" />`;
                }
                const d = eff.DropShadow;
                const flood = `#${[d.color.r, d.color.g, d.color.b]
                    .map((c) =>
                        Math.round(c * 255)
                            .toString(16)
                            .padStart(2, '0'),
                    )
                    .join('')}`;
                return `<feDropShadow dx="${d.dx}" dy="${d.dy}" stdDeviation="${d.blur}" flood-color="${flood}" flood-opacity="${d.color.a}" />`;
            })
            .join('');
        const id = `filter${filterIdCounter++}`;
        // Check if any ColorMatrix effect uses sRGB (non-default) color space.
        const hasSrgbCM = effects.some(
            (eff) => 'ColorMatrix' in eff && eff.ColorMatrix.linear_rgb === false,
        );
        const cifAttr = hasSrgbCM ? ' color-interpolation-filters="sRGB"' : '';
        // No explicit region: our native effects have no region concept, so we
        // rely on SVG's default filter region (-10%..120% of the bbox), which
        // matches how resvg/browsers render these. Emitting an explicit region
        // would also make our own importer rasterize the effect on re-import
        // (it treats a custom region as un-representable natively).
        filterDefs.push(`<filter id="${id}"${cifAttr}>${prims}</filter>`);
        return id;
    };

    /** Convert a Paint to an SVG fill/stroke value. Gradients and patterns add a
     *  <defs> entry and return url(#id); solids return a hex color. */
    const paintToSvgValue = (paint: Paint | null): string => {
        if (!paint) return 'none';
        if (isPattern(paint)) {
            const href = imageDataUris?.[paint.image_id];
            if (!href) return 'none';
            const id = `pat${patternIdCounter++}`;
            const t =
                paint.transform && paint.transform.length === 6
                    ? ` patternTransform="matrix(${paint.transform.join(' ')})"`
                    : '';
            patternDefs.push(
                `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${paint.width}" height="${paint.height}"${t}>` +
                    `<image href="${href}" x="0" y="0" width="${paint.width}" height="${paint.height}" preserveAspectRatio="none" />` +
                    `</pattern>`,
            );
            return `url(#${id})`;
        }
        if (isMeshGradient(paint)) {
            // Mesh FILLS are emitted structurally (a clipped <image> of the
            // rasterized mesh — see renderNodeToSVG); anything that still
            // reaches this generic paint path (a stroke paint, or a mesh
            // without a raster) degrades to the mean vertex color.
            return escapeXml(rgbToHex(meanColor(paint)));
        }
        if (!isGradient(paint)) {
            return escapeXml(rgbToHex(paint));
        }
        // Gradient — create a <defs> entry
        const gradId = `grad${gradientIdCounter++}`;
        const toHex = (c: { r: number; g: number; b: number; a: number }) => {
            const r = Math.round(c.r * 255)
                .toString(16)
                .padStart(2, '0');
            const g = Math.round(c.g * 255)
                .toString(16)
                .padStart(2, '0');
            const b = Math.round(c.b * 255)
                .toString(16)
                .padStart(2, '0');
            return `#${r}${g}${b}`;
        };
        const stops = paint.stops
            .map(
                (s) =>
                    `<stop offset="${s.offset}" stop-color="${toHex(s.color)}" stop-opacity="${s.color.a}" />`,
            )
            .join('');

        // spreadMethod: 0 = pad (default, omitted), 1 = repeat, 2 = reflect.
        const spreadAttr =
            paint.spread === 1
                ? ' spreadMethod="repeat"'
                : paint.spread === 2
                  ? ' spreadMethod="reflect"'
                  : '';

        if (paint.gradient_type === 'Linear') {
            gradientDefs.push(
                `<linearGradient id="${gradId}" x1="${paint.start_x}" y1="${paint.start_y}" ` +
                    `x2="${paint.end_x}" y2="${paint.end_y}" gradientUnits="userSpaceOnUse"${spreadAttr}>` +
                    `${stops}</linearGradient>`,
            );
        } else {
            const radius = Math.hypot(paint.end_x - paint.start_x, paint.end_y - paint.start_y);
            // Radial focal point (fx/fy/fr): emit only when it differs from the
            // center, so concentric gradients stay clean.
            const f = paint.focal;
            const focalAttr = f ? ` fx="${f.x}" fy="${f.y}"${f.r ? ` fr="${f.r}"` : ''}` : '';
            gradientDefs.push(
                `<radialGradient id="${gradId}" cx="${paint.start_x}" cy="${paint.start_y}" ` +
                    `r="${radius}" gradientUnits="userSpaceOnUse"${focalAttr}${spreadAttr}>` +
                    `${stops}</radialGradient>`,
            );
        }
        return `url(#${gradId})`;
    };

    /** Build SVG style attributes string for a shape node.
     *  Reads from the canonical `fills[]` / `strokes[]` arrays, with
     *  fallback to legacy scalar fields for older documents. */
    const buildStyleAttrs = (style: NodeStyle, suppressFill = false): string => {
        // Resolve canonical fill/stroke from arrays, falling back to legacy fields
        const fills = suppressFill
            ? []
            : style.fills && style.fills.length > 0
              ? style.fills
              : style.fill
                ? [style.fill]
                : [];
        const strokeEntries =
            style.strokes && style.strokes.length > 0
                ? style.strokes
                : style.stroke
                  ? [
                        {
                            paint: style.stroke,
                            width: style.stroke_width ?? 0,
                            cap: style.stroke_cap ?? 0,
                            join: style.stroke_join ?? 0,
                            dash_array: style.dash_array ?? [],
                            dash_offset: style.dash_offset ?? 0,
                            miter_limit: style.miter_limit ?? 4,
                        },
                    ]
                  : [];

        const fillPaint = fills.length > 0 ? fills[0] : null;
        const sk = strokeEntries.length > 0 ? strokeEntries[0] : null;

        const fill = paintToSvgValue(fillPaint);
        const stroke = paintToSvgValue(sk?.paint ?? null);
        const sw = sk?.width ?? 0;
        const op = style.opacity ?? 1.0;

        let attrs = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"`;
        attrs += ` stroke-linecap="${CAP_MAP[sk?.cap ?? 0]}"`;
        attrs += ` stroke-linejoin="${JOIN_MAP[sk?.join ?? 0]}"`;

        // Dash array and offset
        if (sk?.dash_array && sk.dash_array.length > 0) {
            attrs += ` stroke-dasharray="${sk.dash_array.join(',')}"`;
            if (sk.dash_offset) attrs += ` stroke-dashoffset="${sk.dash_offset}"`;
        }

        // Miter limit
        if (sk?.miter_limit !== undefined && sk.miter_limit !== 4) {
            attrs += ` stroke-miterlimit="${sk.miter_limit}"`;
        }

        // Fill rule
        const fillRuleIdx = style.fill_rule || 0;
        if (fillRuleIdx > 0) {
            attrs += ` fill-rule="${FILL_RULE_MAP[fillRuleIdx]}"`;
        }

        // Blend mode (on shapes, emitted as inline style)
        const bm = BLEND_MODE_MAP[style.blend_mode || 0];
        if (bm && bm !== 'normal') {
            attrs += ` style="mix-blend-mode:${bm}"`;
        }

        // Fill opacity — extract from fill paint alpha (solid fills only;
        // gradient stops carry their own stop-opacity, patterns have none,
        // mesh vertex colors carry their own alpha).
        if (fillPaint && isSolid(fillPaint) && fillPaint.a < 1) {
            attrs += ` fill-opacity="${fillPaint.a}"`;
        }

        // Stroke opacity — extract from stroke paint alpha
        if (sk?.paint && isSolid(sk.paint) && sk.paint.a < 1) {
            attrs += ` stroke-opacity="${sk.paint.a}"`;
        }

        return attrs;
    };

    /**
     * Render a group's children, bracketing any mask spans. A visible child
     * with is_mask=true masks the siblings above it (up to the next mask or
     * the end of the group) — exported as a <mask> def + a <g mask=...>
     * wrapper. mask-type="alpha" matches our alpha-mask semantics. Masks are
     * group-scoped: only invoked for group children (mutually recursive with
     * renderNodeToSVG), matching the renderer.
     */
    const renderSiblingsWithMasks = (
        siblings: number[],
        suppressFill: boolean,
        parentWorld: number[],
        lp?: { id: number; world: number[] },
    ): string => {
        // Chunks rather than a running string, because the Live Paint faces and
        // edges have to end up INSIDE a `<g mask>` wrapper — emitted around this
        // call (as they used to be) the mask never reaches them, and the export
        // disagrees with the canvas.
        const chunks: { maskId?: string; body: string }[] = [];
        let facesPending = !!lp;
        const takeFaces = () => {
            if (!facesPending || !lp) return '';
            facesPending = false;
            return lpFacesSvg(lp.id, lp.world);
        };
        let ci = 0;
        while (ci < siblings.length) {
            const childId = siblings[ci];
            const child = nodes[childId];
            const isMaskChild = !!(child?.is_mask && child.visible);
            let hasContentAbove = false;
            if (isMaskChild) {
                for (let j = ci + 1; j < siblings.length; j++) {
                    const c = nodes[siblings[j]];
                    if (c?.visible && !c.is_mask) {
                        hasContentAbove = true;
                        break;
                    }
                }
            }
            if (isMaskChild && hasContentAbove) {
                const maskId = `mask${maskIdCounter++}`;
                // Determine mask type from the node's mask_type field.
                const mt = child.mask_type ?? 0;
                const maskTypeVal = mt === 1 ? 'luminance' : 'alpha';
                maskDefs.push(
                    `<mask id="${maskId}" mask-type="${maskTypeVal}" style="mask-type:${maskTypeVal}">` +
                        // Never suppressed: an alpha mask's coverage IS its fill.
                        `${renderNodeToSVG(childId, false, parentWorld)}</mask>`,
                );
                // Gather content siblings up to the next mask.
                let contentSvg = takeFaces();
                let j = ci + 1;
                for (; j < siblings.length; j++) {
                    const c = nodes[siblings[j]];
                    if (c?.is_mask && c.visible) break;
                    contentSvg += renderNodeToSVG(siblings[j], suppressFill, parentWorld);
                }
                chunks.push({ maskId, body: contentSvg });
                ci = j;
            } else {
                chunks.push({
                    body: takeFaces() + renderNodeToSVG(childId, suppressFill, parentWorld),
                });
                ci++;
            }
        }
        // Trailing faces (an empty group still has them) and the painted edges
        // join the last chunk, so they stay inside the mask too.
        const tail = takeFaces() + (lp ? lpEdgesSvg(lp.id, lp.world) : '');
        if (tail) {
            if (chunks.length > 0) chunks[chunks.length - 1].body += tail;
            else chunks.push({ body: tail });
        }
        return chunks
            .map((c) => (c.maskId ? `<g mask="url(#${c.maskId})">${c.body}</g>` : c.body))
            .join('');
    };

    /** Recursively render a node and its children to SVG elements.
     *  `suppressFill` is true inside a Live Paint group — member fills are
     *  provided by the face pass, so shapes emit strokes only.
     *  `parentWorld` is the accumulated transform of the ancestors, needed to
     *  place world-space Live Paint geometry inside a transformed group. */
    const renderNodeToSVG = (
        id: number,
        suppressFill = false,
        parentWorld: number[] = identityMatrix(),
    ): string => {
        const node = nodes[id];
        if (!node) return '';

        // On-path text is drawn in WORLD space (its <textPath> references a
        // world-space path def), so its node transform is bypassed — the glyphs
        // follow the path, not the node's parked position. The renderer does the
        // same by concat'ing the inverse of the text node's WORLD transform, so
        // here the emitted transform must cancel the ancestor chain too — plain
        // identity would let an enclosing group displace the glyphs off the path.
        const onPath =
            node.node_type === 'Text' && node.geometry.Text ? textPaths?.[id] : undefined;

        // Use local (column-major) transform, falling back to identity
        const localTransform = onPath
            ? (invertMatrix(parentWorld) ?? identityMatrix())
            : localTransforms[id] || [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const matrix = matrixToSVGTransform(localTransform);
        // Accumulated world transform of this node — what a world-space overlay
        // (Live Paint faces/edges) has to undo to sit where the canvas draws it.
        const world = composeMatrices(parentWorld, localTransform);

        // Build <g> attributes: transform + visibility
        let gAttrs = `transform="${matrix}"`;
        if (!node.visible) gAttrs += ' display="none"';

        // Effects → a <filter>. Our importer only reads `filter` off leaf
        // shapes (effects are a leaf-node concept), so for a shape we put it on
        // the shape element; only groups carry it on the <g> wrapper. Putting a
        // group filter on the <g> won't round-trip (group effects aren't
        // supported on import), but leaf effects now do.
        const filterId = buildFilterDef(node.style?.effects ?? []);
        const filterAttr = filterId ? ` filter="url(#${filterId})"` : '';
        if (filterId && node.node_type === 'Group') gAttrs += filterAttr;

        let nodeSvg = `<g ${gAttrs}>`;

        if (node.node_type === 'Group') {
            // Group-level opacity
            const groupOp = node.style.opacity ?? 1.0;
            if (groupOp < 1) nodeSvg = `<g ${gAttrs} opacity="${groupOp}">`;

            // Group-level blend mode
            const gbm = BLEND_MODE_MAP[node.style.blend_mode || 0];
            if (gbm && gbm !== 'normal') {
                // Re-build opening tag with style
                const styleAttr = `mix-blend-mode:${gbm}`;
                if (groupOp < 1) {
                    nodeSvg = `<g ${gAttrs} opacity="${groupOp}" style="${styleAttr}">`;
                } else {
                    nodeSvg = `<g ${gAttrs} style="${styleAttr}">`;
                }
            }

            // A Live Paint group brackets its faces (bottom, under the members'
            // strokes) and painted edges (top) — and suppresses member fills.
            const isLP = useLivePaintCompositing && lpGroupSet.has(id);
            const childSuppress = suppressFill || isLP;
            // Children are a sibling list — same mask-span semantics as roots.
            // Faces and edges are emitted in there, so a mask among the children
            // contains them (matching the renderer).
            nodeSvg += renderSiblingsWithMasks(
                node.children || [],
                childSuppress,
                world,
                isLP ? { id, world } : undefined,
            );
        } else {
            // Leaf shape: carry any effect filter on the shape element itself.
            const attrs = buildStyleAttrs(node.style, suppressFill) + filterAttr;
            const geo = node.geometry;

            /** The node's outline element with the given attributes — reused
             *  for both the painted shape and a mesh raster's clip path. */
            const shapeEl = (shapeAttrs: string): string => {
                if (geo.Rect) {
                    const cr = node.style.corner_radius;
                    const rxAttr = cr ? ` rx="${cr}" ry="${cr}"` : '';
                    return `<rect x="0" y="0" width="${geo.Rect.width}" height="${geo.Rect.height}"${rxAttr} ${shapeAttrs} />`;
                }
                if (geo.Ellipse) {
                    return `<ellipse cx="0" cy="0" rx="${geo.Ellipse.radius_x}" ry="${geo.Ellipse.radius_y}" ${shapeAttrs} />`;
                }
                if (geo.Path) {
                    let d = '';
                    for (const sp of geo.Path.subpaths) {
                        if (sp.points.length < 2) continue;
                        d += `M ${sp.points[0].x} ${sp.points[0].y} `;
                        for (let i = 1; i < sp.points.length; i++) {
                            const prev = sp.points[i - 1];
                            const p = sp.points[i];
                            d += `C ${prev.cp2[0]} ${prev.cp2[1]} ${p.cp1[0]} ${p.cp1[1]} ${p.x} ${p.y} `;
                        }
                        if (sp.closed) d += 'Z ';
                    }
                    return `<path d="${d.trim()}" ${shapeAttrs} />`;
                }
                return '';
            };

            // Mesh-gradient fill: SVG 1.1 can't express it, so emit the
            // pre-rasterized mesh as an <image> clipped by the shape's own
            // outline, with the shape itself on top carrying the stroke.
            const firstFill = (node.style.fills ?? [])[0];
            const meshRaster =
                !suppressFill && firstFill && isMeshGradient(firstFill)
                    ? meshRasters?.[meshContentHash(firstFill)]
                    : undefined;
            if (meshRaster && (geo.Rect || geo.Ellipse || geo.Path)) {
                const clipId = `meshclip${id}`;
                const op = node.style.opacity ?? 1.0;
                const opAttr = op < 1 ? ` opacity="${op}"` : '';
                nodeSvg += `<clipPath id="${clipId}">${shapeEl('')}</clipPath>`;
                nodeSvg += `<image href="${meshRaster.href}" x="${meshRaster.x}" y="${meshRaster.y}" width="${meshRaster.w}" height="${meshRaster.h}" preserveAspectRatio="none" clip-path="url(#${clipId})"${opAttr} />`;
                nodeSvg += shapeEl(buildStyleAttrs(node.style, true) + filterAttr);
            } else if (geo.Rect || geo.Ellipse || geo.Path) {
                nodeSvg += shapeEl(attrs);
            } else if (geo.Image) {
                const href = imageDataUris?.[geo.Image.image_id] ?? '';
                const op = node.style.opacity ?? 1.0;
                const opAttr = op < 1 ? ` opacity="${op}"` : '';
                // Emit `image-rendering` so nearest-neighbour sampling survives
                // an export/re-import round trip. `pixelated` is the CSS Images
                // 3 keyword; `optimizeSpeed` is the SVG 1.1 spelling that resvg
                // and older renderers understand, so prefer it for portability.
                const renderAttr = geo.Image.pixelated ? ' image-rendering="optimizeSpeed"' : '';
                nodeSvg += `<image x="0" y="0" width="${geo.Image.width}" height="${geo.Image.height}" href="${href}"${opAttr}${renderAttr}${filterAttr} preserveAspectRatio="none" />`;
            } else if (geo.Text) {
                const textAnchorMap = ['start', 'middle', 'end'];
                const fontFamily = geo.Text.font_family
                    ? ` font-family="${escapeXml(geo.Text.font_family)}"`
                    : '';
                const textAnchor = geo.Text.text_align
                    ? ` text-anchor="${textAnchorMap[geo.Text.text_align] || 'start'}"`
                    : '';
                const lineHeightAttr =
                    geo.Text.line_height && geo.Text.line_height !== 1.2
                        ? ` line-height="${geo.Text.line_height}"`
                        : '';
                const fw = geo.Text.font_weight ?? 400;
                const weightAttr = fw !== 400 ? ` font-weight="${fw}"` : '';
                const styleAttr = geo.Text.italic ? ` font-style="italic"` : '';
                const ls = geo.Text.letter_spacing ?? 0;
                const lsAttr = ls ? ` letter-spacing="${ls}"` : '';
                const content = geo.Text.content;
                const lines = content.split('\n');
                if (onPath) {
                    // Text on a path: reference a world-space path def via <textPath>.
                    const defId = `tp-${id}`;
                    textPathDefs.push(`<path id="${defId}" d="${onPath.d}" fill="none"/>`);
                    nodeSvg += `<text font-size="${geo.Text.font_size}"${fontFamily}${weightAttr}${styleAttr}${lsAttr} ${attrs}><textPath href="#${defId}">${escapeXml(content.replace(/\n/g, ' '))}</textPath></text>`;
                } else if (lines.length <= 1) {
                    nodeSvg += `<text x="0" y="0" font-size="${geo.Text.font_size}"${fontFamily}${textAnchor}${lineHeightAttr}${weightAttr}${styleAttr}${lsAttr} ${attrs}>${escapeXml(content)}</text>`;
                } else {
                    const lh = geo.Text.line_height || 1.2;
                    nodeSvg += `<text x="0" y="0" font-size="${geo.Text.font_size}"${fontFamily}${textAnchor}${lineHeightAttr}${weightAttr}${styleAttr}${lsAttr} ${attrs}>`;
                    for (let i = 0; i < lines.length; i++) {
                        const dy = i === 0 ? '0' : `${lh}em`;
                        nodeSvg += `<tspan x="0" dy="${dy}">${escapeXml(lines[i])}</tspan>`;
                    }
                    nodeSvg += '</text>';
                }
            }
        }
        nodeSvg += `</g>`;
        return nodeSvg;
    };

    // Masks are group-scoped — root nodes render plainly (matches the renderer).
    for (const rootId of rootNodeIds) {
        svg += renderNodeToSVG(rootId, false);
    }

    // Legacy fallback: when there's no per-group render data, append live-paint
    // face fills on TOP of the scene tree. Prefer the exact-bézier outline
    // (M…C…Z); fall back to the flattened polygon (M…L…Z).
    if (!useLivePaintCompositing && filledFaces && filledFaces.length > 0) {
        for (const face of filledFaces) {
            let d: string;
            if (face.outline && face.outline.length >= 2) {
                const o = face.outline;
                d = `M ${o[0].x} ${o[0].y}`;
                for (let i = 0; i < o.length - 1; i++) {
                    const a = o[i],
                        b = o[i + 1];
                    d += ` C ${a.cp2[0]} ${a.cp2[1]} ${b.cp1[0]} ${b.cp1[1]} ${b.x} ${b.y}`;
                }
                const a = o[o.length - 1],
                    b = o[0];
                d += ` C ${a.cp2[0]} ${a.cp2[1]} ${b.cp1[0]} ${b.cp1[1]} ${b.x} ${b.y} Z`;
            } else {
                d = `${face.boundary
                    .map(
                        (p: [number, number], i: number) =>
                            `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`,
                    )
                    .join(' ')} Z`;
            }
            const hex = rgbToHex(face.fill);
            svg += `<path d="${d}" fill="${hex}" fill-opacity="${face.fill.a}" stroke="none" data-face-id="${face.id}" />`;
        }
    }

    // Insert <defs> (gradients + masks + filters + patterns + text paths) if any
    if (
        gradientDefs.length > 0 ||
        maskDefs.length > 0 ||
        filterDefs.length > 0 ||
        patternDefs.length > 0 ||
        textPathDefs.length > 0
    ) {
        const defsBlock = `<defs>${gradientDefs.join('')}${maskDefs.join('')}${filterDefs.join('')}${patternDefs.join('')}${textPathDefs.join('')}</defs>`;
        // Insert after the opening <svg ...> tag
        const insertIdx = svg.indexOf('>') + 1;
        svg = svg.slice(0, insertIdx) + defsBlock + svg.slice(insertIdx);
    }

    svg += `</svg>`;
    return svg;
}
