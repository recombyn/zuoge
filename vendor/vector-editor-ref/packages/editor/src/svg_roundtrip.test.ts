/**
 * SVG Export + Round-Trip Test Suite
 *
 * Tests the pure SVG export (buildSVGFromData) and validates round-trip
 * fidelity by exporting scene data → parsing the SVG DOM → asserting
 * element/attribute equivalence.
 *
 * Does NOT require WASM — works entirely with the pure export module
 * and jsdom's DOMParser.
 */
import { describe, expect, it } from 'vitest';
import type { FilledFace, SVGExportInput } from './svg_export';
import { BLEND_MODE_MAP, buildSVGFromData, CANVAS_BACKGROUND_ROLE } from './svg_export';
import type { NodeStyle, SceneNode } from './types';
import { StrokeAlignment } from './types';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a default NodeStyle with sane zero/default values. */
function defaultStyle(overrides: Partial<NodeStyle> = {}): NodeStyle {
    return {
        fill: { r: 0.5, g: 0.5, b: 0.5, a: 1.0 },
        stroke: null,
        stroke_width: 1,
        opacity: 1.0,
        stroke_cap: 0,
        stroke_join: 0,
        dash_array: [],
        dash_offset: 0,
        corner_radius: 0,
        blend_mode: 0,
        fill_rule: 0,
        miter_limit: 4,
        fill_opacity: 1.0,
        fills: [],
        strokes: [],
        ...overrides,
    };
}

/** Build a minimal SceneNode. */
function makeNode(overrides: Partial<SceneNode>): SceneNode {
    return {
        name: 'Node',
        node_type: 'Shape',
        geometry: {},
        style: defaultStyle(),
        visible: true,
        locked: false,
        // A node's own transform is decomposed components. The export reads
        // matrices from `localTransforms`, not from here.
        transform: {
            x: 0,
            y: 0,
            rotation_deg: 0,
            skew_x_deg: 0,
            skew_y_deg: 0,
            scale_x: 1,
            scale_y: 1,
        },

        ...overrides,
    };
}

/** Identity matrix (column-major [f32; 9]) for `localTransforms`. */
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Parse an SVG string and return the document. */
function parseSVG(svgString: string): Document {
    const parser = new DOMParser();
    return parser.parseFromString(svgString, 'image/svg+xml');
}

/** Get the first element matching a tag inside the SVG. */
function queryTag(doc: Document, tag: string): Element | null {
    return doc.querySelector(tag);
}

/** Get all elements matching a tag. */
function queryAllTags(doc: Document, tag: string): NodeListOf<Element> {
    return doc.querySelectorAll(tag);
}

// ─── Export: Basic Shapes ───────────────────────────────────────────────────

describe('SVG Export — Basic Shapes', () => {
    it('exports a rect with correct dimensions', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 200, height: 100 } },
                    style: defaultStyle({ fill: { r: 1, g: 0, b: 0, a: 1 } }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const rect = queryTag(doc, 'rect');
        expect(rect).toBeTruthy();
        expect(rect!.getAttribute('width')).toBe('200');
        expect(rect!.getAttribute('height')).toBe('100');
        expect(rect!.getAttribute('fill')).toBe('#ff0000');
    });

    it('exports an ellipse', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Ellipse: { radius_x: 50, radius_y: 30 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const el = queryTag(doc, 'ellipse');
        expect(el).toBeTruthy();
        expect(el!.getAttribute('rx')).toBe('50');
        expect(el!.getAttribute('ry')).toBe('30');
    });

    it('exports a path with cubic beziers', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: {
                        Path: {
                            subpaths: [
                                {
                                    points: [
                                        { x: 0, y: 0, cp1: [0, 0], cp2: [50, 0] },
                                        { x: 100, y: 100, cp1: [50, 100], cp2: [100, 100] },
                                    ],
                                    closed: false,
                                },
                            ],
                        },
                    },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const path = queryTag(doc, 'path');
        expect(path).toBeTruthy();
        const d = path!.getAttribute('d')!;
        expect(d).toContain('M');
        expect(d).toContain('C');
    });

    it('exports text with escaped content', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: {
                        Text: {
                            content: 'Hello <World> & "Friends"',
                            font_size: 24,
                            font_family: 'sans-serif',
                            text_align: 0,
                            line_height: 1.2,
                        },
                    },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const text = queryTag(doc, 'text');
        expect(text).toBeTruthy();
        expect(text!.getAttribute('font-size')).toBe('24');
        // The text content should be properly escaped in the SVG string
        expect(svg).toContain('&amp;');
        expect(svg).toContain('&lt;World&gt;');
    });
});

// ─── Export: Masks ──────────────────────────────────────────────────────────

describe('SVG Export — Masks', () => {
    it('a group with an is_mask child exports a <mask> def and a masked <g>', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({ node_type: 'Group', children: [2, 3] }),
                // mask (bottom child) — an ellipse
                2: makeNode({
                    node_type: 'Shape',
                    is_mask: true,
                    geometry: { Ellipse: { radius_x: 60, radius_y: 60 } },
                }),
                // content (above) — a red rect
                3: makeNode({
                    node_type: 'Shape',
                    geometry: { Rect: { width: 200, height: 200 } },
                    style: defaultStyle({ fill: { r: 1, g: 0, b: 0, a: 1 } }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY, 2: IDENTITY, 3: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const mask = queryTag(doc, 'mask');
        expect(mask, 'a <mask> def must be emitted').toBeTruthy();
        expect(mask!.getAttribute('mask-type')).toBe('alpha');
        // The mask def contains the ellipse (the mask shape).
        expect(mask!.querySelector('ellipse'), 'mask shape inside def').toBeTruthy();

        // The content is wrapped in a <g mask="url(#...)">.
        const maskId = mask!.getAttribute('id')!;
        const maskedG = Array.from(doc.querySelectorAll('g')).find(
            (g) => g.getAttribute('mask') === `url(#${maskId})`,
        );
        expect(maskedG, 'content wrapped in a masked group').toBeTruthy();
        expect(maskedG!.querySelector('rect'), 'content rect inside masked group').toBeTruthy();
        // The mask shape must NOT also be painted as normal content.
        expect(maskedG!.querySelector('ellipse')).toBeFalsy();
    });

    it('masks are group-scoped: a root-level is_mask flag exports plainly', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                // roots: [flagged node (bottom), content (above)] — no group, so
                // the flag is inert and both shapes export as normal content.
                1: makeNode({
                    node_type: 'Shape',
                    is_mask: true,
                    geometry: { Ellipse: { radius_x: 50, radius_y: 50 } },
                }),
                2: makeNode({
                    node_type: 'Shape',
                    geometry: { Rect: { width: 300, height: 300 } },
                }),
            },
            rootNodeIds: [1, 2],
            localTransforms: { 1: IDENTITY, 2: IDENTITY },
        };
        const doc = parseSVG(buildSVGFromData(input));
        expect(queryTag(doc, 'mask'), 'no <mask> def outside a group').toBeFalsy();
        expect(queryTag(doc, 'ellipse'), 'flagged shape still exports').toBeTruthy();
        expect(queryTag(doc, 'rect'), 'content untouched').toBeTruthy();
    });

    it.each([
        [true, 'optimizeSpeed'],
        [false, null],
    ])('an image node with pixelated=%s exports image-rendering=%s', (pixelated, expected) => {
        // `image-rendering` is a rendering instruction, not decoration: if the
        // export drops it, reopening the file silently blurs pixel art and the
        // loss is invisible in the markup — the <image> is still there.
        const input: SVGExportInput = {
            docWidth: 200,
            docHeight: 200,
            nodes: {
                1: makeNode({
                    geometry: { Image: { width: 64, height: 64, image_id: 7, pixelated } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
            imageDataUris: { 7: 'data:image/png;base64,AAAA' },
        };
        const doc = parseSVG(buildSVGFromData(input));
        const image = queryTag(doc, 'image');
        expect(image, 'an <image> is emitted').toBeTruthy();
        expect(image!.getAttribute('image-rendering')).toBe(expected);
    });

    it('a pattern-filled node exports a <pattern> with an <image> tile', () => {
        const input: SVGExportInput = {
            docWidth: 400,
            docHeight: 400,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 100 } },
                    style: defaultStyle({
                        fills: [
                            { image_id: 7, width: 20, height: 20, transform: [1, 0, 0, 1, 3, 4] },
                        ] as never,
                    }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
            imageDataUris: { 7: 'data:image/png;base64,AAAA' },
        };
        const doc = parseSVG(buildSVGFromData(input));
        const pat = queryTag(doc, 'pattern');
        expect(pat, 'a <pattern> def is emitted').toBeTruthy();
        expect(pat!.getAttribute('width')).toBe('20');
        expect(pat!.getAttribute('patternUnits')).toBe('userSpaceOnUse');
        expect(
            pat!.getAttribute('patterntransform') || pat!.getAttribute('patternTransform'),
        ).toContain('matrix(1 0 0 1 3 4)');
        const image = pat!.querySelector('image');
        expect(image, 'tile <image> inside the pattern').toBeTruthy();
        expect(image!.getAttribute('href')).toBe('data:image/png;base64,AAAA');
        // The rect references the pattern.
        const pid = pat!.getAttribute('id')!;
        const rect = queryTag(doc, 'rect')!;
        expect(rect.getAttribute('fill')).toBe(`url(#${pid})`);
    });

    it('exports spreadMethod and a radial focal point', () => {
        const input: SVGExportInput = {
            docWidth: 400,
            docHeight: 400,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 100 } },
                    style: defaultStyle({
                        fills: [
                            {
                                gradient_type: 'Radial',
                                stops: [
                                    { offset: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
                                    { offset: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
                                ],
                                start_x: 50,
                                start_y: 50,
                                end_x: 90,
                                end_y: 50,
                                spread: 1,
                                focal: { x: 30, y: 20, r: 0 },
                            },
                        ] as never,
                    }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };
        const doc = parseSVG(buildSVGFromData(input));
        const rg = queryTag(doc, 'radialGradient')!;
        expect(rg, 'a <radialGradient> def is emitted').toBeTruthy();
        expect(rg.getAttribute('spreadMethod')).toBe('repeat');
        expect(rg.getAttribute('fx')).toBe('30');
        expect(rg.getAttribute('fy')).toBe('20');
    });

    it('a node with a drop-shadow effect exports a <filter> with feDropShadow', () => {
        const input: SVGExportInput = {
            docWidth: 400,
            docHeight: 400,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 100 } },
                    style: defaultStyle({
                        effects: [
                            {
                                DropShadow: {
                                    dx: 5,
                                    dy: 6,
                                    blur: 4,
                                    color: { r: 0, g: 0, b: 0, a: 0.5 },
                                },
                            },
                        ],
                    }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };
        const doc = parseSVG(buildSVGFromData(input));
        const filter = queryTag(doc, 'filter');
        expect(filter, 'a <filter> def is emitted').toBeTruthy();
        const shadow = doc.querySelector('feDropShadow');
        expect(shadow).toBeTruthy();
        expect(shadow!.getAttribute('dx')).toBe('5');
        expect(shadow!.getAttribute('stdDeviation')).toBe('4');
        // A leaf shape carries the filter on the shape element itself (so the
        // importer, which reads `filter` off leaf shapes, round-trips it).
        const fid = filter!.getAttribute('id')!;
        const ref = Array.from(doc.querySelectorAll('rect')).find(
            (x) => x.getAttribute('filter') === `url(#${fid})`,
        );
        expect(ref, 'leaf shape references the filter').toBeTruthy();
    });

    it('a node with a color-matrix effect exports feColorMatrix', () => {
        const gray = [
            0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0,
            0, 0, 0, 0, 1, 0,
        ];
        const input: SVGExportInput = {
            docWidth: 400,
            docHeight: 400,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 100 } },
                    style: defaultStyle({ effects: [{ ColorMatrix: { matrix: gray } }] }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };
        const doc = parseSVG(buildSVGFromData(input));
        const cm = doc.querySelector('feColorMatrix');
        expect(cm).toBeTruthy();
        expect(cm!.getAttribute('type')).toBe('matrix');
        expect(cm!.getAttribute('values')).toContain('0.2126 0.7152 0.0722');
    });

    it('a node with a blur effect exports feGaussianBlur', () => {
        const input: SVGExportInput = {
            docWidth: 400,
            docHeight: 400,
            nodes: {
                1: makeNode({
                    geometry: { Ellipse: { radius_x: 40, radius_y: 40 } },
                    style: defaultStyle({ effects: [{ Blur: { radius: 7 } }] }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };
        const doc = parseSVG(buildSVGFromData(input));
        const blur = doc.querySelector('feGaussianBlur');
        expect(blur).toBeTruthy();
        expect(blur!.getAttribute('stdDeviation')).toBe('7');
    });

    it('a mask with no content above it renders normally (not wrapped)', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({ node_type: 'Group', children: [2, 3] }),
                2: makeNode({
                    node_type: 'Shape',
                    geometry: { Rect: { width: 100, height: 100 } },
                }),
                // mask is the TOP child → nothing above to mask
                3: makeNode({
                    node_type: 'Shape',
                    is_mask: true,
                    geometry: { Ellipse: { radius_x: 40, radius_y: 40 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY, 2: IDENTITY, 3: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        expect(queryTag(doc, 'mask'), 'no mask def when nothing to mask').toBeFalsy();
        // Both shapes are drawn plainly.
        expect(queryTag(doc, 'rect')).toBeTruthy();
        expect(queryTag(doc, 'ellipse')).toBeTruthy();
    });
});

// ─── Export: Corner Radius ──────────────────────────────────────────────────

describe('SVG Export — Corner Radius', () => {
    it('exports rx/ry on rect when corner_radius > 0', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 80 } },
                    style: defaultStyle({ corner_radius: 12 }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('rx')).toBe('12');
        expect(rect!.getAttribute('ry')).toBe('12');
    });

    it('omits rx/ry when corner_radius is 0', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 80 } },
                    style: defaultStyle({ corner_radius: 0 }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('rx')).toBeNull();
        expect(rect!.getAttribute('ry')).toBeNull();
    });
});

// ─── Export: Dash Patterns ──────────────────────────────────────────────────

describe('SVG Export — Dash Patterns', () => {
    it('exports stroke-dasharray and stroke-dashoffset', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({
                        stroke: { r: 0, g: 0, b: 0, a: 1 },
                        dash_array: [10, 5, 2, 5],
                        dash_offset: 3,
                    }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('stroke-dasharray')).toBe('10,5,2,5');
        expect(rect!.getAttribute('stroke-dashoffset')).toBe('3');
    });

    it('omits dash attributes when dash_array is empty', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ dash_array: [] }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('stroke-dasharray')).toBeNull();
    });
});

// ─── Export: Stroke Properties ──────────────────────────────────────────────

describe('SVG Export — Stroke Properties', () => {
    it('exports stroke-linecap and stroke-linejoin', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({
                        stroke: { r: 0, g: 0, b: 0, a: 1 },
                        stroke_cap: 1, // round
                        stroke_join: 2, // bevel
                    }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('stroke-linecap')).toBe('round');
        expect(rect!.getAttribute('stroke-linejoin')).toBe('bevel');
    });

    it('exports non-default miter limit', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({
                        strokes: [
                            {
                                paint: { r: 0, g: 0, b: 0, a: 1 },
                                width: 1,
                                cap: 0,
                                join: 0,
                                dash_array: [],
                                dash_offset: 0,
                                miter_limit: 8,
                                alignment: StrokeAlignment.Center,
                            },
                        ],
                    }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('stroke-miterlimit')).toBe('8');
    });

    it('omits miter limit when it is the default (4)', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ miter_limit: 4 }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('stroke-miterlimit')).toBeNull();
    });
});

// ─── Export: Fill Rule and Opacity ───────────────────────────────────────────

describe('SVG Export — Fill Rule & Opacity', () => {
    it('exports fill-rule="evenodd" when set', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ fill_rule: 1 }), // evenodd
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('fill-rule')).toBe('evenodd');
    });

    it('omits fill-rule when nonzero (default)', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ fill_rule: 0 }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('fill-rule')).toBeNull();
    });

    it('exports fill-opacity when not 1', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ fills: [{ r: 0.5, g: 0.5, b: 0.5, a: 0.5 }] }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('fill-opacity')).toBe('0.5');
    });

    it('exports element opacity', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ opacity: 0.7 }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('opacity')).toBe('0.7');
    });
});

// ─── Export: Visibility ─────────────────────────────────────────────────────

describe('SVG Export — Visibility', () => {
    it('emits display="none" for invisible nodes', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    visible: false,
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const groups = queryAllTags(doc, 'g');
        // The wrapping <g> should have display="none"
        let found = false;
        for (const g of groups) {
            if (g.getAttribute('display') === 'none') {
                found = true;
                break;
            }
        }
        expect(found).toBe(true);
        // The rect should still be present (not skipped)
        expect(queryTag(doc, 'rect')).toBeTruthy();
    });

    it('visible nodes do not have display="none"', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    visible: true,
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        expect(svg).not.toContain('display="none"');
    });
});

// ─── Export: Blend Mode ─────────────────────────────────────────────────────

describe('SVG Export — Blend Mode', () => {
    it('exports mix-blend-mode for non-normal blend mode on shapes', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ blend_mode: 1 }), // multiply
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        expect(svg).toContain('mix-blend-mode:multiply');
    });

    it('omits mix-blend-mode for normal blend mode', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ blend_mode: 0 }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        expect(svg).not.toContain('mix-blend-mode');
    });

    it('exports mix-blend-mode on group nodes', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    style: defaultStyle({ blend_mode: 2 }), // screen
                    children: [2],
                }),
                2: makeNode({
                    geometry: { Rect: { width: 50, height: 30 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY, 2: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        expect(svg).toContain('mix-blend-mode:screen');
    });

    it('BLEND_MODE_MAP covers all 16 modes', () => {
        expect(BLEND_MODE_MAP).toHaveLength(16);
        expect(BLEND_MODE_MAP[0]).toBe('normal');
        expect(BLEND_MODE_MAP[15]).toBe('luminosity');
    });
});

// ─── Export: Transforms ─────────────────────────────────────────────────────

describe('SVG Export — Transforms', () => {
    it('exports local transform as matrix()', () => {
        // Column-major: translate(100, 200) = [1,0,0, 0,1,0, 100,200,1]
        const translateMat = [1, 0, 0, 0, 1, 0, 100, 200, 1];
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 50, height: 50 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: translateMat },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const g = queryTag(doc, 'g');
        const transform = g!.getAttribute('transform')!;

        // matrixToSVGTransform([1,0,0, 0,1,0, 100,200,1]) → matrix(1,0,0,1,100,200)
        expect(transform).toContain('matrix(');
        expect(transform).toContain('100');
        expect(transform).toContain('200');
    });

    it('exports rotation transform correctly', () => {
        // 90° rotation column-major: [cos, sin, 0, -sin, cos, 0, 0, 0, 1]
        // cos(90°) ≈ 0, sin(90°) = 1
        const angle = Math.PI / 2;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const rotMat = [c, s, 0, -s, c, 0, 0, 0, 1];

        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 50, height: 50 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: rotMat },
        };

        const svg = buildSVGFromData(input);
        expect(svg).toContain('matrix(');
    });

    it('uses identity when no transform provided', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 50, height: 50 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: {}, // No transform provided
        };

        const svg = buildSVGFromData(input);
        // Should fall back to identity → matrix(1,0,0,1,0,0)
        expect(svg).toContain('matrix(1,0,0,1,0,0)');
    });
});

// ─── Export: Nested Groups ──────────────────────────────────────────────────

describe('SVG Export — Nested Groups', () => {
    it('exports groups with children nested correctly', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    children: [2, 3],
                }),
                2: makeNode({
                    geometry: { Rect: { width: 50, height: 50 } },
                }),
                3: makeNode({
                    geometry: { Ellipse: { radius_x: 25, radius_y: 25 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: {
                1: [1, 0, 0, 0, 1, 0, 10, 20, 1], // translate(10, 20)
                2: IDENTITY,
                3: IDENTITY,
            },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        // Should have a rect and ellipse
        expect(queryTag(doc, 'rect')).toBeTruthy();
        expect(queryTag(doc, 'ellipse')).toBeTruthy();
        // Should have multiple <g> elements (one for group, one each for children)
        const groups = queryAllTags(doc, 'g');
        expect(groups.length).toBeGreaterThanOrEqual(3);
    });

    it('exports group opacity', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    style: defaultStyle({ opacity: 0.5 }),
                    children: [2],
                }),
                2: makeNode({
                    geometry: { Rect: { width: 50, height: 50 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY, 2: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        // The outermost group <g> should have opacity="0.5"
        const groups = queryAllTags(doc, 'g');
        let foundGroupOpacity = false;
        for (const g of groups) {
            if (g.getAttribute('opacity') === '0.5') {
                foundGroupOpacity = true;
                break;
            }
        }
        expect(foundGroupOpacity).toBe(true);
    });

    it('nested groups with transforms produce hierarchical SVG', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    children: [2],
                }),
                2: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    children: [3],
                }),
                3: makeNode({
                    geometry: { Rect: { width: 20, height: 20 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: {
                1: [1, 0, 0, 0, 1, 0, 10, 0, 1], // translate(10, 0)
                2: [1, 0, 0, 0, 1, 0, 0, 20, 1], // translate(0, 20)
                3: IDENTITY,
            },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        // Should have a rect nested inside groups
        expect(queryTag(doc, 'rect')).toBeTruthy();
        const groups = queryAllTags(doc, 'g');
        // Group 1 > Group 2 > shape wrapper > rect = at least 3 <g>s
        expect(groups.length).toBeGreaterThanOrEqual(3);
    });
});

// ─── Export: Face Fills ─────────────────────────────────────────────────────

describe('SVG Export — Face Fills', () => {
    it('exports filled faces as path elements after scene content', () => {
        const faces: FilledFace[] = [
            {
                id: 42,
                boundary: [
                    [0, 0],
                    [100, 0],
                    [100, 100],
                    [0, 100],
                ],
                fill: { r: 1, g: 0, b: 0, a: 0.8 },
            },
        ];

        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 200, height: 200 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
            filledFaces: faces,
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        // Should have at least 2 paths (could be rect + face path)
        // The face path has data-face-id attribute
        const paths = queryAllTags(doc, 'path');
        let facePathFound = false;
        for (const p of paths) {
            if (p.getAttribute('data-face-id') === '42') {
                facePathFound = true;
                expect(p.getAttribute('fill')).toBe('#ff0000');
                expect(p.getAttribute('fill-opacity')).toBe('0.8');
                expect(p.getAttribute('stroke')).toBe('none');
            }
        }
        expect(facePathFound).toBe(true);
    });

    it('no face paths when filledFaces is undefined', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 200, height: 200 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        expect(svg).not.toContain('data-face-id');
    });
});

// ─── Export: SVG Document Structure ─────────────────────────────────────────

describe('SVG Export — Document Structure', () => {
    it('produces valid SVG with correct root attributes', () => {
        const input: SVGExportInput = {
            docWidth: 1920,
            docHeight: 1080,
            nodes: {},
            rootNodeIds: [],
            localTransforms: {},
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const svgEl = queryTag(doc, 'svg');

        expect(svgEl).toBeTruthy();
        expect(svgEl!.getAttribute('width')).toBe('1920');
        expect(svgEl!.getAttribute('height')).toBe('1080');
        expect(svgEl!.getAttribute('viewBox')).toBe('0 0 1920 1080');
        expect(svgEl!.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    });

    it('inserts gradient defs when gradients are used', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 100 } },
                    style: defaultStyle({
                        fill: {
                            gradient_type: 'Linear',
                            stops: [
                                { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
                                { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
                            ],
                            start_x: 0,
                            start_y: 0,
                            end_x: 100,
                            end_y: 0,
                        },
                    }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const defs = queryTag(doc, 'defs');
        expect(defs).toBeTruthy();
        const linearGrad = queryTag(doc, 'linearGradient');
        expect(linearGrad).toBeTruthy();
        expect(linearGrad!.getAttribute('gradientUnits')).toBe('userSpaceOnUse');

        // The rect should reference the gradient
        const rect = queryTag(doc, 'rect');
        expect(rect!.getAttribute('fill')).toMatch(/^url\(#grad\d+\)$/);
    });
});

// ─── Round-Trip: Export → Parse → Verify ────────────────────────────────────

describe('SVG Round-Trip — Export then Parse', () => {
    it('round-trips a rect with all style fields', () => {
        const style = defaultStyle({
            fill: { r: 0.2, g: 0.4, b: 0.8, a: 0.75 },
            stroke: { r: 1, g: 0, b: 0, a: 1.0 },
            stroke_width: 3,
            opacity: 0.9,
            stroke_cap: 1,
            stroke_join: 2,
            dash_array: [8, 4],
            dash_offset: 2,
            corner_radius: 10,
            fill_rule: 1,
            miter_limit: 8,
            blend_mode: 3, // overlay
        });

        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 150, height: 100 } },
                    style,
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: [1, 0, 0, 0, 1, 0, 50, 30, 1] },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect')!;

        // Geometry
        expect(rect.getAttribute('width')).toBe('150');
        expect(rect.getAttribute('height')).toBe('100');
        expect(rect.getAttribute('rx')).toBe('10');
        expect(rect.getAttribute('ry')).toBe('10');

        // Fill & stroke
        expect(rect.getAttribute('fill')).toBe('#3366cc');
        expect(rect.getAttribute('stroke')).toBe('#ff0000');
        expect(rect.getAttribute('stroke-width')).toBe('3');

        // Opacity
        expect(rect.getAttribute('opacity')).toBe('0.9');
        expect(rect.getAttribute('fill-opacity')).toBe('0.75');

        // Stroke properties
        expect(rect.getAttribute('stroke-linecap')).toBe('round');
        expect(rect.getAttribute('stroke-linejoin')).toBe('bevel');
        expect(rect.getAttribute('stroke-dasharray')).toBe('8,4');
        expect(rect.getAttribute('stroke-dashoffset')).toBe('2');
        expect(rect.getAttribute('stroke-miterlimit')).toBe('8');

        // Fill rule
        expect(rect.getAttribute('fill-rule')).toBe('evenodd');

        // Blend mode
        expect(rect.getAttribute('style')).toContain('mix-blend-mode:overlay');

        // Transform on parent <g>
        const g = rect.parentElement!;
        const transform = g.getAttribute('transform')!;
        expect(transform).toContain('50');
        expect(transform).toContain('30');
    });

    it('round-trips nested groups with transforms', () => {
        const input: SVGExportInput = {
            docWidth: 400,
            docHeight: 400,
            nodes: {
                1: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    children: [2, 3],
                }),
                2: makeNode({
                    geometry: { Rect: { width: 40, height: 40 } },
                }),
                3: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    children: [4],
                }),
                4: makeNode({
                    geometry: { Ellipse: { radius_x: 20, radius_y: 15 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: {
                1: [1, 0, 0, 0, 1, 0, 100, 100, 1],
                2: [2, 0, 0, 0, 2, 0, 0, 0, 1], // scale(2)
                3: [1, 0, 0, 0, 1, 0, 50, 0, 1], // translate(50, 0)
                4: IDENTITY,
            },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        // Both shapes should exist
        expect(queryTag(doc, 'rect')).toBeTruthy();
        expect(queryTag(doc, 'ellipse')).toBeTruthy();

        // Count groups
        const groups = queryAllTags(doc, 'g');
        expect(groups.length).toBeGreaterThanOrEqual(4); // outer + child rect wrapper + inner group + ellipse wrapper
    });

    it('round-trips text node', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: {
                        Text: {
                            content: 'Héllo Wörld',
                            font_size: 32,
                            font_family: 'sans-serif',
                            text_align: 0,
                            line_height: 1.2,
                        },
                    },
                    style: defaultStyle({ fill: { r: 0, g: 0, b: 0, a: 1 } }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: [1, 0, 0, 0, 1, 0, 20, 50, 1] },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const text = queryTag(doc, 'text')!;

        expect(text.getAttribute('font-size')).toBe('32');
        expect(text.textContent).toBe('Héllo Wörld');
        expect(text.getAttribute('fill')).toBe('#000000');
    });

    it('cancels the ancestor transform for text on a path', () => {
        // The <textPath> def is in WORLD coordinates (like Live Paint geometry),
        // and the renderer undoes the text node's world transform before laying
        // glyphs on the curve. Inside a transformed group the exported text must
        // therefore carry the inverse of the ancestor chain — an identity
        // transform would slide the glyphs off the path by the group's offset.
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({ node_type: 'Group', children: [2] }),
                2: makeNode({
                    node_type: 'Text',
                    geometry: {
                        Text: {
                            content: 'on a path',
                            font_size: 24,
                            font_family: 'sans-serif',
                            text_align: 0,
                            line_height: 1.2,
                        },
                    },
                    style: defaultStyle({ fill: { r: 0, g: 0, b: 0, a: 1 } }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: {
                1: [1, 0, 0, 0, 1, 0, 120, 60, 1], // group parked at (120,60)
                2: [1, 0, 0, 0, 1, 0, 40, 40, 1], // bypassed for on-path text
            },
            textPaths: { 2: { pathId: 3, d: 'M 200 200 C 260 120 340 120 400 200' } },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const text = queryTag(doc, 'text')!;
        expect(text.parentElement!.getAttribute('transform')).toBe('matrix(1,0,0,1,-120,-60)');
        expect(queryTag(doc, 'textPath')!.getAttribute('href')).toBe('#tp-2');
    });

    it('round-trips dashes + rounded rects', () => {
        const input: SVGExportInput = {
            docWidth: 600,
            docHeight: 400,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 200, height: 120 } },
                    style: defaultStyle({
                        fill: { r: 0.9, g: 0.9, b: 0.9, a: 1 },
                        stroke: { r: 0.2, g: 0.2, b: 0.2, a: 1 },
                        stroke_width: 2,
                        corner_radius: 16,
                        dash_array: [12, 6],
                        dash_offset: 4,
                    }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect')!;

        expect(rect.getAttribute('rx')).toBe('16');
        expect(rect.getAttribute('ry')).toBe('16');
        expect(rect.getAttribute('stroke-dasharray')).toBe('12,6');
        expect(rect.getAttribute('stroke-dashoffset')).toBe('4');
        expect(rect.getAttribute('stroke-width')).toBe('2');
    });

    it('round-trips path with closed subpath', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: {
                        Path: {
                            subpaths: [
                                {
                                    points: [
                                        { x: 0, y: 0, cp1: [0, 0], cp2: [0, 0] },
                                        { x: 100, y: 0, cp1: [100, 0], cp2: [100, 0] },
                                        { x: 50, y: 87, cp1: [50, 87], cp2: [50, 87] },
                                    ],
                                    closed: true,
                                },
                            ],
                        },
                    },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const path = queryTag(doc, 'path')!;
        const d = path.getAttribute('d')!;

        expect(d).toContain('M');
        expect(d).toContain('Z');
    });
});

// ─── Round-Trip: Multiple Shapes ────────────────────────────────────────────

describe('SVG Round-Trip — Scene with Multiple Shapes', () => {
    it('exports all root-level shapes in order', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({ geometry: { Rect: { width: 100, height: 50 } } }),
                2: makeNode({ geometry: { Ellipse: { radius_x: 40, radius_y: 40 } } }),
                3: makeNode({
                    geometry: {
                        Path: {
                            subpaths: [
                                {
                                    points: [
                                        { x: 0, y: 0, cp1: [0, 0], cp2: [0, 0] },
                                        { x: 50, y: 50, cp1: [50, 50], cp2: [50, 50] },
                                    ],
                                    closed: false,
                                },
                            ],
                        },
                    },
                }),
            },
            rootNodeIds: [1, 2, 3],
            localTransforms: { 1: IDENTITY, 2: IDENTITY, 3: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        expect(queryTag(doc, 'rect')).toBeTruthy();
        expect(queryTag(doc, 'ellipse')).toBeTruthy();
        expect(queryTag(doc, 'path')).toBeTruthy();

        // The SVG should have 3 top-level <g> elements under <svg>
        const svgEl = queryTag(doc, 'svg')!;
        const topLevelGs = svgEl.querySelectorAll(':scope > g');
        expect(topLevelGs.length).toBe(3);
    });

    it('mixes visible and invisible shapes', () => {
        const input: SVGExportInput = {
            docWidth: 800,
            docHeight: 600,
            nodes: {
                1: makeNode({ geometry: { Rect: { width: 100, height: 50 } }, visible: true }),
                2: makeNode({ geometry: { Rect: { width: 80, height: 40 } }, visible: false }),
            },
            rootNodeIds: [1, 2],
            localTransforms: { 1: IDENTITY, 2: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const rects = queryAllTags(doc, 'rect');
        expect(rects.length).toBe(2); // Both should be present

        // One group should have display="none"
        const groups = queryAllTags(doc, 'g');
        let hiddenCount = 0;
        for (const g of groups) {
            if (g.getAttribute('display') === 'none') hiddenCount++;
        }
        expect(hiddenCount).toBe(1);
    });
});

// ─── Export: Artboard viewBox + background ───────────────────────────────────

describe('SVG Export — viewBox and background', () => {
    const baseNode = () => ({
        1: makeNode({
            geometry: { Rect: { width: 100, height: 100 } },
            style: defaultStyle({ fill: { r: 0, g: 0, b: 1, a: 1 } }),
        }),
    });

    it('defaults the viewBox to the document size', () => {
        const svg = buildSVGFromData({
            docWidth: 800,
            docHeight: 600,
            nodes: baseNode(),
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        });
        expect(svg).toContain('viewBox="0 0 800 600"');
        expect(svg).toContain('width="800"');
        expect(svg).toContain('height="600"');
    });

    it('uses an explicit artboard viewBox with a non-zero origin', () => {
        const svg = buildSVGFromData({
            docWidth: 800,
            docHeight: 600,
            nodes: baseNode(),
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
            viewBox: { x: 1200, y: 50, w: 400, h: 300 },
        });
        expect(svg).toContain('viewBox="1200 50 400 300"');
        expect(svg).toContain('width="400"');
        expect(svg).toContain('height="300"');
    });

    it('emits a background rect covering the viewBox when given', () => {
        const svg = buildSVGFromData({
            docWidth: 400,
            docHeight: 300,
            nodes: baseNode(),
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
            viewBox: { x: 0, y: 0, w: 400, h: 300 },
            background: { r: 1, g: 1, b: 1, a: 1 },
        });
        const doc = parseSVG(svg);
        const rects = queryAllTags(doc, 'rect');
        // First rect is the background (full-viewBox, white).
        const bg = rects[0];
        expect(bg.getAttribute('width')).toBe('400');
        expect(bg.getAttribute('height')).toBe('300');
        expect(bg.getAttribute('fill')).toContain('rgba(255,255,255');
    });

    it('marks the background rect as the canvas, not artwork', () => {
        // Import skips this rect on the way back in. Without the marker,
        // opening our own export adds a real full-canvas rectangle to the
        // layer list — and a second round trip adds another one.
        const svg = buildSVGFromData({
            docWidth: 400,
            docHeight: 300,
            nodes: baseNode(),
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
            viewBox: { x: 0, y: 0, w: 400, h: 300 },
            background: { r: 1, g: 1, b: 1, a: 1 },
        });
        const rects = queryAllTags(parseSVG(svg), 'rect');
        expect(rects[0].getAttribute('data-rcb-vector-role')).toBe(CANVAS_BACKGROUND_ROLE);
        // The artwork itself must NOT be marked — only the background is.
        expect(rects[1].getAttribute('data-rcb-vector-role')).toBeNull();
    });

    it('omits the background rect when none is given', () => {
        const svg = buildSVGFromData({
            docWidth: 400,
            docHeight: 300,
            nodes: baseNode(),
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        });
        const doc = parseSVG(svg);
        // Only the content rect (100×100), no full-size background.
        const rects = queryAllTags(doc, 'rect');
        expect(rects.length).toBe(1);
        expect(rects[0].getAttribute('width')).toBe('100');
    });
});

// ─── Export: Live Paint compositing ──────────────────────────────────────────

describe('SVG Export — Live Paint compositing', () => {
    /** A group (id 1) with one rect member (id 2), flagged as Live Paint. */
    const lpScene = (): SVGExportInput => ({
        docWidth: 400,
        docHeight: 400,
        nodes: {
            1: makeNode({ node_type: 'Group', children: [2] }),
            2: makeNode({
                geometry: { Rect: { width: 100, height: 100 } },
                style: defaultStyle({
                    fills: [{ r: 1, g: 0, b: 0, a: 1 }],
                    strokes: [
                        {
                            paint: { r: 0, g: 0, b: 0, a: 1 },
                            width: 4,
                            cap: 0,
                            join: 0,
                            dash_array: [],
                            dash_offset: 0,
                            miter_limit: 4,
                            alignment: StrokeAlignment.Center,
                        },
                    ],
                }),
            }),
        },
        rootNodeIds: [1],
        localTransforms: { 1: IDENTITY, 2: IDENTITY },
    });

    it('draws faces under member strokes and suppresses member fills', () => {
        const input = lpScene();
        input.livePaint = {
            groups: [1],
            faces: [
                {
                    group: 1,
                    boundary: [
                        [0, 0],
                        [100, 0],
                        [100, 100],
                        [0, 100],
                    ],
                    fill: { r: 0, g: 1, b: 0, a: 1 },
                },
            ],
            edges: [],
        };
        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        // The member rect keeps its stroke but its fill is suppressed.
        const rect = queryTag(doc, 'rect')!;
        expect(rect.getAttribute('fill')).toBe('none');
        expect(rect.getAttribute('stroke')).toBe('#000000');

        // The face path is emitted (green), and it comes BEFORE the member rect
        // in document order (drawn under it).
        const facePath = queryTag(doc, 'path')!;
        expect(facePath.getAttribute('fill')).toBe('#00ff00');
        expect(svg.indexOf('#00ff00')).toBeLessThan(svg.indexOf('<rect'));
    });

    it('draws painted edges on top of members as open strokes', () => {
        const input = lpScene();
        input.livePaint = {
            groups: [1],
            faces: [],
            edges: [
                {
                    group: 1,
                    width: 6,
                    color: { r: 0, g: 0, b: 1, a: 1 },
                    outline: [
                        { x: 0, y: 0, cp1: [0, 0], cp2: [0, 0] },
                        { x: 100, y: 0, cp1: [100, 0], cp2: [100, 0] },
                    ],
                },
            ],
        };
        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const edge = Array.from(queryAllTags(doc, 'path')).find(
            (p) => p.getAttribute('stroke') === '#0000ff',
        )!;
        expect(edge).toBeTruthy();
        expect(edge.getAttribute('fill')).toBe('none'); // open stroke, not filled
        expect(edge.getAttribute('stroke-width')).toBe('6');
        expect(edge.getAttribute('d')).not.toContain('Z'); // open path
    });

    it('cancels the group transform for world-space faces and edges', () => {
        // Faces/edges come out of the engine in WORLD coordinates but are
        // emitted inside the group's <g transform=…> (for z-order). A group
        // always carries a translate to its bbox corner, so without an inverse
        // wrapper the fills land offset by that much — off the artboard, which
        // is why they went missing from exports of real documents.
        const input = lpScene();
        input.localTransforms[1] = [1, 0, 0, 0, 1, 0, 300, 200, 1]; // group at (300,200)
        input.livePaint = {
            groups: [1],
            faces: [
                {
                    group: 1,
                    boundary: [
                        [300, 200],
                        [400, 200],
                        [400, 300],
                    ],
                    fill: { r: 0, g: 1, b: 0, a: 1 },
                },
            ],
            edges: [
                {
                    group: 1,
                    width: 6,
                    color: { r: 0, g: 0, b: 1, a: 1 },
                    outline: [
                        { x: 300, y: 200, cp1: [300, 200], cp2: [300, 200] },
                        { x: 400, y: 200, cp1: [400, 200], cp2: [400, 200] },
                    ],
                },
            ],
        };
        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const face = Array.from(queryAllTags(doc, 'path')).find(
            (p) => p.getAttribute('fill') === '#00ff00',
        )!;
        const edge = Array.from(queryAllTags(doc, 'path')).find(
            (p) => p.getAttribute('stroke') === '#0000ff',
        )!;
        expect(face).toBeTruthy();
        expect(edge).toBeTruthy();
        // Each sits under a wrapper undoing the group's translate, so the net
        // transform on the world coordinates is identity.
        for (const el of [face, edge]) {
            const wrapper = el.parentElement!;
            expect(wrapper.getAttribute('transform')).toBe('matrix(1,0,0,1,-300,-200)');
        }
    });

    it('leaves world geometry unwrapped when the group is untransformed', () => {
        const input = lpScene();
        input.livePaint = {
            groups: [1],
            faces: [
                {
                    group: 1,
                    boundary: [
                        [0, 0],
                        [100, 0],
                        [100, 100],
                    ],
                    fill: { r: 0, g: 1, b: 0, a: 1 },
                },
            ],
            edges: [],
        };
        const svg = buildSVGFromData(input);
        expect(svg).not.toContain('matrix(1,0,0,1,-0,-0)');
    });

    it('renders two Live Paint groups independently', () => {
        const input: SVGExportInput = {
            docWidth: 400,
            docHeight: 400,
            nodes: {
                1: makeNode({ node_type: 'Group', children: [2] }),
                2: makeNode({
                    geometry: { Rect: { width: 100, height: 100 } },
                    style: defaultStyle({ fills: [{ r: 1, g: 0, b: 0, a: 1 }] }),
                }),
                3: makeNode({ node_type: 'Group', children: [4] }),
                4: makeNode({
                    geometry: { Rect: { width: 100, height: 100 } },
                    style: defaultStyle({ fills: [{ r: 0, g: 0, b: 1, a: 1 }] }),
                }),
            },
            rootNodeIds: [1, 3],
            localTransforms: { 1: IDENTITY, 2: IDENTITY, 3: IDENTITY, 4: IDENTITY },
            livePaint: {
                groups: [1, 3],
                faces: [
                    {
                        group: 1,
                        boundary: [
                            [0, 0],
                            [100, 0],
                            [100, 100],
                        ],
                        fill: { r: 0, g: 1, b: 0, a: 1 },
                    },
                    {
                        group: 3,
                        boundary: [
                            [0, 0],
                            [100, 0],
                            [100, 100],
                        ],
                        fill: { r: 1, g: 1, b: 0, a: 1 },
                    },
                ],
                edges: [],
            },
        };
        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const fills = Array.from(queryAllTags(doc, 'path')).map((p) => p.getAttribute('fill'));
        expect(fills).toContain('#00ff00'); // group 1's face
        expect(fills).toContain('#ffff00'); // group 3's face
        // Both member rects have suppressed fills.
        const rectFills = Array.from(queryAllTags(doc, 'rect')).map((r) => r.getAttribute('fill'));
        expect(rectFills.every((f) => f === 'none')).toBe(true);
    });
});

// ─── Export: a mask over a Live Paint group ─────────────────────────────────

describe('SVG Export — a mask over a Live Paint group', () => {
    /** Live Paint group (1) whose children are [mask ellipse (2), rect (3)]. */
    const maskedLpScene = (): SVGExportInput => ({
        docWidth: 400,
        docHeight: 400,
        nodes: {
            1: makeNode({ node_type: 'Group', children: [2, 3] }),
            2: makeNode({
                node_type: 'Ellipse',
                geometry: { Ellipse: { radius_x: 80, radius_y: 80 } },
                style: defaultStyle({ fills: [{ r: 0, g: 0, b: 0, a: 1 }] }),
                is_mask: true,
            }),
            3: makeNode({
                geometry: { Rect: { width: 100, height: 100 } },
                style: defaultStyle({ fills: [{ r: 1, g: 0, b: 0, a: 1 }] }),
            }),
        },
        rootNodeIds: [1],
        localTransforms: { 1: IDENTITY, 2: IDENTITY, 3: IDENTITY },
        livePaint: {
            groups: [1],
            faces: [
                {
                    group: 1,
                    boundary: [
                        [0, 0],
                        [100, 0],
                        [100, 100],
                        [0, 100],
                    ],
                    fill: { r: 0, g: 1, b: 0, a: 1 },
                },
            ],
            edges: [],
        },
    });

    it('puts the painted faces INSIDE the mask group', () => {
        // Emitted outside the wrapper, the mask never reaches them and the file
        // disagrees with what the canvas showed.
        const doc = parseSVG(buildSVGFromData(maskedLpScene()));

        const masked = queryTag(doc, 'g[mask]');
        expect(masked).toBeTruthy();
        const faceInside = masked!.querySelector('path[fill="#00ff00"]');
        expect(faceInside).toBeTruthy();
        // ...and nowhere else.
        const allFaces = doc.querySelectorAll('path[fill="#00ff00"]');
        expect(allFaces.length).toBe(1);
    });

    it('keeps the mask shape its fill — that fill IS the coverage', () => {
        const doc = parseSVG(buildSVGFromData(maskedLpScene()));

        const mask = queryTag(doc, 'mask');
        expect(mask).toBeTruthy();
        const shape = mask!.querySelector('ellipse');
        expect(shape).toBeTruthy();
        expect(shape!.getAttribute('fill')).toBe('#000000');
    });

    it('still suppresses fills on ordinary members', () => {
        const doc = parseSVG(buildSVGFromData(maskedLpScene()));
        const rect = queryTag(doc, 'rect');
        expect(rect!.getAttribute('fill')).toBe('none');
    });
});

// ─── Export: a Live Paint region filled with a gradient ─────────────────────

describe('SVG Export — a gradient in a Live Paint region', () => {
    const gradientFaceScene = (): SVGExportInput => ({
        docWidth: 400,
        docHeight: 400,
        nodes: {
            1: makeNode({ node_type: 'Group', children: [2] }),
            2: makeNode({
                geometry: { Rect: { width: 100, height: 100 } },
                style: defaultStyle({ fills: [{ r: 1, g: 0, b: 0, a: 1 }] }),
            }),
        },
        rootNodeIds: [1],
        localTransforms: { 1: IDENTITY, 2: IDENTITY },
        livePaint: {
            groups: [1],
            faces: [
                {
                    group: 1,
                    boundary: [
                        [0, 0],
                        [100, 0],
                        [100, 100],
                        [0, 100],
                    ],
                    fill: { r: 1, g: 0, b: 0, a: 1 },
                    paint: {
                        gradient_type: 'Linear',
                        stops: [
                            { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
                            { offset: 1, color: { r: 0, g: 1, b: 0, a: 1 } },
                        ],
                        start_x: 0,
                        start_y: 0,
                        end_x: 100,
                        end_y: 0,
                    },
                } as never,
            ],
            edges: [],
        },
    });

    it('emits a gradient def and points the region at it', () => {
        const doc = parseSVG(buildSVGFromData(gradientFaceScene()));

        const grad = queryTag(doc, 'linearGradient');
        expect(grad).toBeTruthy();
        expect(
            [...grad!.querySelectorAll('stop')].map((s) => s.getAttribute('stop-color')),
        ).toEqual(['#ff0000', '#00ff00']);
        const face = doc.querySelector(`path[fill="url(#${grad!.getAttribute('id')})"]`);
        expect(face).toBeTruthy();
    });

    it('falls back to the flat colour when there is no paint', () => {
        // Data from an older engine carries `fill` only.
        const input = gradientFaceScene();
        (input.livePaint!.faces[0] as { paint?: unknown }).paint = undefined;

        const doc = parseSVG(buildSVGFromData(input));

        expect(queryTag(doc, 'linearGradient')).toBeNull();
        expect(doc.querySelector('path[fill="#ff0000"]')).toBeTruthy();
    });
});
