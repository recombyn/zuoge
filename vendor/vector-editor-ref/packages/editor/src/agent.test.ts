/**
 * Contracts for the agent authoring API (`EditorHandle.agent`).
 *
 * The invariant worth pinning is undo granularity: ONE agent call must be
 * exactly ONE undo step, so a human can step back through an agent's work at
 * the same granularity they'd step through their own. This is easy to break —
 * every `WasmScene` wrapper pushes its own history entry, so a composite verb
 * like `createRect({fill})` (add + style) silently becomes two steps unless it
 * is wrapped in `transaction()`.
 *
 * "Exactly one" is provable by byte-comparing `serialize_scene()` against the
 * pre-call snapshot: if the call pushed 0 steps, one undo overshoots past it;
 * if it pushed 2, one undo lands on an intermediate state. Only exactly-one
 * lands byte-equal on the pre-call state.
 *
 * Runs against the REAL wasm engine + History, stubbing only the renderer,
 * autosave and CanvasKit that this path never touches.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { type AgentApi, createAgentApi } from './agent';
import { WasmScene } from './wasm_scene';

/** The wasm exports, kept so scenes can be given real linear memory — some
 *  reads (node transforms) go through it directly rather than JSON. */
let wasm: { memory: WebAssembly.Memory };

beforeAll(async () => {
    wasm = (await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    })) as unknown as { memory: WebAssembly.Memory };
});

function makeAgent(): { agent: AgentApi; scene: WasmScene; selection: number[] } {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    scene.wasm = wasm;
    // Selection is owned by the UI engine in the real editor; here a plain
    // array stands in, which is all the agent API actually needs.
    const state = { selection: [] as number[] };
    const agent = createAgentApi({
        scene,
        ck: {} as never,
        getSelection: () => state.selection,
        setSelection: (ids) => {
            state.selection = ids;
        },
        exportSVG: () => '<svg/>',
        // SVG import needs the UI engine's DOM parsing and raster fallbacks,
        // neither of which exists headless; the importSVG tests assert the
        // validation that happens before this is ever reached.
        importSVG: async () => [],
        // Rasterizing needs the renderer's offscreen surface, which doesn't
        // exist headless; the transports are covered by the MCP smoke test.
        renderPNG: async () => '',
        // Font fetching needs the network and a DOM; the contract these tests
        // pin is that createText assigns a real family, not that it downloads.
        ensureFont: () => {},
        // Real measurement needs CanvasKit's paragraph API and a font provider,
        // neither of which exists headless. Returning null is the documented
        // "can't measure" path, which falls back to the engine's estimate.
        measureText: () => null,
        fontsReady: async () => {},
    });
    return { agent, scene, selection: state.selection };
}

const snapshot = (scene: WasmScene): number[] => Array.from(scene.engine!.serialize_scene());

/**
 * Assert `fn` produces exactly one undo step: after running it, a single undo
 * must land byte-equal on the state captured before it ran.
 */
function expectOneUndoStep(label: string, fn: (a: AgentApi, s: WasmScene) => void) {
    const { agent, scene } = makeAgent();
    // Seed a shape so verbs that need an existing target have one, and so the
    // pre-state is non-trivial (an empty scene would mask an overshooting undo).
    const seed = agent.createRect(0, 0, 10, 10);
    const before = snapshot(scene);

    fn(agent, scene);
    expect(snapshot(scene), `${label} should have changed the scene`).not.toEqual(before);

    scene.undo();
    expect(snapshot(scene), `${label} should be exactly one undo step`).toEqual(before);
    return seed;
}

describe('agent API — undo granularity', () => {
    it('createRect with style is one step, not two', () => {
        expectOneUndoStep('createRect+style', (a) => {
            a.createRect(20, 20, 50, 50, { fill: '#ff0000', stroke: '#000000', strokeWidth: 2 });
        });
    });

    it('createEllipse with style is one step', () => {
        expectOneUndoStep('createEllipse+style', (a) => {
            a.createEllipse(40, 40, 20, 10, { fill: '#00ff00' });
        });
    });

    it('createPath with style is one step', () => {
        expectOneUndoStep('createPath+style', (a) => {
            a.createPath(
                [
                    { x: 0, y: 0 },
                    { x: 50, y: 0 },
                    { x: 50, y: 50 },
                ],
                true,
                { fill: '#0000ff' },
            );
        });
    });

    it('setFill across MULTIPLE nodes is one step for the whole batch', () => {
        const { agent, scene } = makeAgent();
        const a1 = agent.createRect(0, 0, 10, 10);
        const a2 = agent.createRect(20, 0, 10, 10);
        const a3 = agent.createRect(40, 0, 10, 10);
        const before = snapshot(scene);

        agent.setFill([a1, a2, a3], '#123456');
        expect(snapshot(scene)).not.toEqual(before);

        scene.undo();
        expect(snapshot(scene), 'a 3-node recolor is one undo, not three').toEqual(before);
    });

    it('move across multiple nodes is one step', () => {
        const { agent, scene } = makeAgent();
        const a1 = agent.createRect(0, 0, 10, 10);
        const a2 = agent.createRect(20, 0, 10, 10);
        const before = snapshot(scene);

        agent.move([a1, a2], 15, 25);
        scene.undo();
        expect(snapshot(scene)).toEqual(before);
    });

    it('group is one step', () => {
        const { agent, scene } = makeAgent();
        const a1 = agent.createRect(0, 0, 10, 10);
        const a2 = agent.createRect(20, 0, 10, 10);
        const before = snapshot(scene);

        agent.group([a1, a2]);
        scene.undo();
        expect(snapshot(scene)).toEqual(before);
    });

    it('removing multiple nodes is one step', () => {
        const { agent, scene } = makeAgent();
        const a1 = agent.createRect(0, 0, 10, 10);
        const a2 = agent.createRect(20, 0, 10, 10);
        const before = snapshot(scene);

        agent.remove([a1, a2]);
        scene.undo();
        expect(snapshot(scene), 'a 2-node delete is one undo, not two').toEqual(before);
    });
});

describe('agent API — describe()', () => {
    it('reports geometry and style in the units the agent supplied', async () => {
        const { agent } = makeAgent();
        agent.createRect(10, 20, 100, 50, { fill: '#ff0000' });

        const desc = await agent.describe();
        expect(desc.nodes).toHaveLength(1);
        const [node] = desc.nodes;
        expect(node.fill).toBe('#ff0000');
        // Bounds are [x, y, w, h] in world units — the same numbers that went in.
        expect(node.bounds[2]).toBeCloseTo(100, 1);
        expect(node.bounds[3]).toBeCloseTo(50, 1);
    });

    it('nests children under groups so the agent can see structure', async () => {
        const { agent } = makeAgent();
        const a1 = agent.createRect(0, 0, 10, 10);
        const a2 = agent.createRect(20, 0, 10, 10);
        agent.group([a1, a2]);

        const desc = await agent.describe();
        expect(desc.nodes).toHaveLength(1);
        expect(desc.nodes[0].children?.map((c) => c.id).sort()).toEqual([a1, a2].sort());
    });

    it('returns null fill for unfilled nodes rather than inventing a colour', async () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10);
        agent.setFill(id, null);
        expect((await agent.describeNode(id))?.fill).toBeNull();
    });

    it('describeNode returns null for an unknown id', async () => {
        const { agent } = makeAgent();
        expect(await agent.describeNode(99999)).toBeNull();
    });
});

describe('agent API — input validation', () => {
    it('rejects a malformed colour instead of silently painting black', () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10);
        expect(() => agent.setFill(id, 'not-a-colour')).toThrow(/invalid color/);
    });

    it('accepts shorthand and alpha hex forms', async () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10);
        agent.setFill(id, '#f00');
        expect((await agent.describeNode(id))?.fill).toBe('#ff0000');
        agent.setFill(id, '#ff000080');
        expect((await agent.describeNode(id))?.fill).toMatch(/^#ff0000/);
    });

    it('rejects a path with too few points', () => {
        const { agent } = makeAgent();
        expect(() => agent.createPath([{ x: 0, y: 0 }])).toThrow(/at least 2 points/);
    });

    // A stale id otherwise reaches getNodeStyle, whose JSON.parse of the
    // engine's empty string surfaces as "Unexpected end of JSON input" — which
    // tells an agent nothing about what went wrong or how to recover.
    it('names the unknown id instead of leaking a JSON parse error', () => {
        const { agent } = makeAgent();
        expect(() => agent.setFill(999, '#ffffff')).toThrow(/no object with id 999/);
        expect(() => agent.rotate(999, 45)).toThrow(/no object with id 999/);
        expect(() => agent.remove(999)).toThrow(/no object with id 999/);
    });

    it('reports every missing id in a batch, not just the first', () => {
        const { agent } = makeAgent();
        const ok = agent.createRect(0, 0, 10, 10);
        expect(() => agent.setFill([ok, 777, 888], '#ffffff')).toThrow(/777, 888/);
    });

    it('rejects a boolean op on fewer than 2 nodes', () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10);
        expect(() => agent.boolean([id], 'union')).toThrow(/at least 2 nodes/);
    });
});

describe('agent API — createPath geometry', () => {
    // The engine's `add_path` deserializes with `unwrap_or_default()`, so a
    // control-point shape mismatch produces a silently EMPTY path — it renders
    // as nothing and reports zero bounds, with no error anywhere. Pin the real
    // geometry so a format drift fails loudly here instead of in artwork.
    it('produces a path with real bounds, not a silently empty one', async () => {
        const { agent } = makeAgent();
        const id = agent.createPath(
            [
                { x: 270, y: 350 },
                { x: 450, y: 220 },
                { x: 630, y: 350 },
            ],
            true,
            { fill: '#a63d40' },
        );
        const node = await agent.describeNode(id);
        expect(node, 'path node should exist').not.toBeNull();
        const [, , w, h] = node!.bounds;
        expect(w, 'path width should span the supplied points').toBeCloseTo(360, 0);
        expect(h, 'path height should span the supplied points').toBeCloseTo(130, 0);
    });

    it('honours explicit control points', async () => {
        const { agent } = makeAgent();
        const id = agent.createPath(
            [
                { x: 0, y: 0 },
                { x: 100, y: 0, cp1x: 25, cp1y: -60, cp2x: 75, cp2y: -60 },
            ],
            false,
        );
        // The curve bulges above y=0, so the bbox must be taller than the
        // straight-line case (which would be zero-height).
        expect((await agent.describeNode(id))!.bounds[3]).toBeGreaterThan(0);
    });
});

describe('agent API — creation defaults', () => {
    // The engine's default node style has a black 2px stroke. A human sees and
    // deletes it; an agent won't notice a thin dark outline in a render and
    // will ship artwork with unintended borders. Creation must be opt-in.
    it('does not add a stroke the caller never asked for', async () => {
        const { agent } = makeAgent();
        const id = agent.createEllipse(100, 100, 45, 45, { fill: '#f5c542' });
        expect(
            (await agent.describeNode(id))?.stroke,
            'a fill-only request means no outline',
        ).toBeNull();
    });

    // The engine defaults text to a WHITE fill, which is invisible on the
    // default white artboard. The node describes fine and draws nothing, so an
    // agent has no way to diagnose it — it just sees a blank canvas.
    it('does not create text that is invisible on a white canvas', async () => {
        const { agent } = makeAgent();
        const id = agent.createText(10, 10, 'hello', 24);
        expect((await agent.describeNode(id))?.fill).toBe('#000000');
    });

    it('still honours an explicit text colour', async () => {
        const { agent } = makeAgent();
        const id = agent.createText(10, 10, 'hello', 24, { fill: '#ff0000' });
        expect((await agent.describeNode(id))?.fill).toBe('#ff0000');
    });

    it('leaves a bare shape unstroked too', async () => {
        const { agent } = makeAgent();
        expect((await agent.describeNode(agent.createRect(0, 0, 10, 10)))?.stroke).toBeNull();
    });

    it('still applies a stroke when one IS requested', async () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10, { stroke: '#5c4033', strokeWidth: 4 });
        const node = await agent.describeNode(id);
        expect(node?.stroke).toBe('#5c4033');
        expect(node?.strokeWidth).toBe(4);
    });
});

describe('agent API — canvas', () => {
    // Without this an agent cannot centre anything or reason about margins.
    // I hit exactly this drawing an icon: the only way to learn the canvas
    // size was reading ruler markings out of a PNG.
    it('reports the artboard so the agent can centre artwork', async () => {
        const { agent } = makeAgent();
        const canvas = (await agent.describe()).canvas;
        expect(canvas).not.toBeNull();
        expect(canvas!.width).toBeGreaterThan(0);
        expect(canvas!.height).toBeGreaterThan(0);
    });

    it('resizes the canvas', async () => {
        const { agent } = makeAgent();
        agent.setCanvas({ width: 512, height: 512 });
        const canvas = (await agent.describe()).canvas;
        expect([canvas!.width, canvas!.height]).toEqual([512, 512]);
    });

    it('fits the canvas around the artwork with a margin', async () => {
        const { agent } = makeAgent();
        agent.createRect(100, 200, 50, 80);
        agent.fitCanvasToArtwork(20);
        const canvas = (await agent.describe()).canvas!;
        expect(canvas.x).toBeCloseTo(80, 0);
        expect(canvas.y).toBeCloseTo(180, 0);
        expect(canvas.width).toBeCloseTo(90, 0);
        expect(canvas.height).toBeCloseTo(120, 0);
    });

    /**
     * fitCanvasToArtwork read the engine's raw bounds while describeNode used
     * the measured ones, so a fitted canvas framed text by the estimate and
     * clipped it. Caught by fitting a real logo and looking at the render:
     * a 46pt wordmark was cropped mid-word because 7 bytes * 46 * 0.6 = 193
     * against a true 255. The two must agree, so they now share one path.
     */
    it('fits around MEASURED text, not the engine estimate', () => {
        const scene = new WasmScene({} as never);
        scene.engine = new Engine();
        scene.history = new History(50);
        scene.wasm = wasm;
        const agent = createAgentApi({
            scene,
            ck: {} as never,
            getSelection: () => [],
            setSelection: () => {},
            exportSVG: () => '<svg/>',
            importSVG: async () => [],
            renderPNG: async () => '',
            ensureFont: () => {},
            // Deliberately much wider than the engine's estimate would be.
            measureText: () => ({ width: 400, height: 50 }),
            fontsReady: async () => {},
        });

        agent.createText(0, 100, 'SOLARIS', 46);
        agent.fitCanvasToArtwork(0);
        return agent.describe().then((d) => {
            expect(d.canvas!.width, 'canvas must span the measured width').toBeCloseTo(400, 0);
        });
    });

    it('refuses to fit an empty canvas rather than producing a degenerate one', () => {
        const { agent } = makeAgent();
        expect(() => agent.fitCanvasToArtwork()).toThrow(/canvas is empty/);
    });
});

describe('agent API — SVG path data', () => {
    it('accepts an SVG d attribute', async () => {
        const { agent } = makeAgent();
        const id = agent.createPathData('M 0 0 L 100 0 L 100 100 L 0 100 Z', { fill: '#ff0000' });
        const [, , w, h] = (await agent.describeNode(id))!.bounds;
        expect(w).toBeCloseTo(100, 0);
        expect(h).toBeCloseTo(100, 0);
    });

    it('handles curves and arcs the point form cannot express', async () => {
        const { agent } = makeAgent();
        const id = agent.createPathData('M 0 50 A 50 50 0 1 1 100 50 Z');
        const [, , w, h] = (await agent.describeNode(id))!.bounds;
        expect(w).toBeGreaterThan(50);
        expect(h).toBeGreaterThan(20);
    });

    // The engine turns unparseable data into an empty path with no error, so
    // this has to be caught at the boundary or artwork silently loses shapes.
    it('rejects data that yields no geometry instead of a silent empty path', () => {
        const { agent } = makeAgent();
        expect(() => agent.createPathData('not path data')).toThrow(/no drawable geometry/);
    });
});

describe('agent API — gradients', () => {
    it('applies a linear gradient and reports it as a gradient fill', async () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 100, 100);
        agent.setGradient(id, {
            type: 'linear',
            angle: 90,
            stops: [
                { offset: 0, color: '#ff0000' },
                { offset: 1, color: '#0000ff' },
            ],
        });
        const node = (await agent.describeNode(id))!;
        // `fill` can only carry solids, so the kind must be reported separately
        // or a gradient is indistinguishable from no fill at all.
        expect(node.fill).toBeNull();
        expect(node.fillType).toBe('gradient');
    });

    it('applies a radial gradient', async () => {
        const { agent } = makeAgent();
        const id = agent.createEllipse(50, 50, 40, 40);
        agent.setGradient(id, {
            type: 'radial',
            stops: [
                { offset: 0, color: '#ffffff' },
                { offset: 1, color: '#000000' },
            ],
        });
        expect((await agent.describeNode(id))!.fillType).toBe('gradient');
    });

    /**
     * Asserting only `fillType === 'gradient'` is not enough — it passed while
     * gradients rendered as flat colour. Local space differs per node type: a
     * Rect spans 0..w from a top-left origin, an Ellipse spans -r..r about the
     * centre. Endpoints computed as if everything were centred land outside a
     * Rect, so the shape pads to the last stop and looks solid. So check the
     * endpoints actually straddle each shape's own box.
     */
    const gradientOf = (scene: WasmScene, id: number) => {
        const paint = scene.getNodeStyle(id)?.fills?.[0] as {
            start_x: number;
            start_y: number;
            end_x: number;
            end_y: number;
        };
        return paint;
    };

    it('spans a RECT across its own local box (origin at top-left)', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createRect(0, 0, 160, 160);
        agent.setGradient(id, {
            type: 'linear',
            angle: 90,
            stops: [
                { offset: 0, color: '#ec4899' },
                { offset: 1, color: '#3b82f6' },
            ],
        });
        const g = gradientOf(scene, id);
        // A rect's local box is 0..160, so the gradient must run 0 → 160 in y,
        // NOT -80 → 80 (which would leave most of the shape past the last stop).
        expect(g.start_y).toBeCloseTo(0, 0);
        expect(g.end_y).toBeCloseTo(160, 0);
    });

    it('spans an ELLIPSE across its own local box (centred on origin)', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createEllipse(200, 200, 50, 50);
        agent.setGradient(id, {
            type: 'linear',
            angle: 0,
            stops: [
                { offset: 0, color: '#000000' },
                { offset: 1, color: '#ffffff' },
            ],
        });
        const g = gradientOf(scene, id);
        expect(g.start_x).toBeCloseTo(-50, 0);
        expect(g.end_x).toBeCloseTo(50, 0);
    });

    it('centres a radial gradient on the shape, not on the origin', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createRect(0, 0, 100, 100);
        agent.setGradient(id, {
            type: 'radial',
            stops: [
                { offset: 0, color: '#ffffff' },
                { offset: 1, color: '#000000' },
            ],
        });
        const g = gradientOf(scene, id);
        expect(g.start_x).toBeCloseTo(50, 0);
        expect(g.start_y).toBeCloseTo(50, 0);
    });

    // cos(90°) is 6e-17, not 0, so an unsnapped endpoint ships into every
    // exported SVG as "-1.7145055e-14".
    it('emits clean endpoints rather than floating-point noise', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createRect(0, 0, 200, 200);
        agent.setGradient(id, {
            type: 'linear',
            angle: 90,
            stops: [
                { offset: 0, color: '#000000' },
                { offset: 1, color: '#ffffff' },
            ],
        });
        const g = gradientOf(scene, id);
        expect(g.start_x).toBe(100);
        expect(g.end_x).toBe(100);
    });

    it('rejects a gradient with too few stops', () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10);
        expect(() =>
            agent.setGradient(id, { type: 'linear', stops: [{ offset: 0, color: '#fff' }] }),
        ).toThrow(/at least 2 stops/);
    });

    it('is one undo step across a batch', () => {
        const { agent, scene } = makeAgent();
        const a1 = agent.createRect(0, 0, 10, 10);
        const a2 = agent.createRect(20, 0, 10, 10);
        const before = snapshot(scene);
        agent.setGradient([a1, a2], {
            type: 'linear',
            stops: [
                { offset: 0, color: '#000000' },
                { offset: 1, color: '#ffffff' },
            ],
        });
        scene.undo();
        expect(snapshot(scene)).toEqual(before);
    });
});

describe('agent API — z-order', () => {
    it('brings a node to the front and sends it to the back', () => {
        const { agent, scene } = makeAgent();
        const bottom = agent.createRect(0, 0, 10, 10);
        agent.createRect(5, 5, 10, 10);
        const roots = () => Array.from(scene.getRootNodes());

        expect(roots()[0]).toBe(bottom);
        agent.bringToFront(bottom);
        expect(roots()[roots().length - 1]).toBe(bottom);
        agent.sendToBack(bottom);
        expect(roots()[0]).toBe(bottom);
    });
});

describe('agent API — text', () => {
    const textGeom = (scene: WasmScene, id: number) => scene.getNode(id)!.geometry.Text!;

    it('edits content without discarding typography', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createText(10, 10, 'hello', 24);
        agent.setText(id, { weight: 700, italic: true });
        agent.setText(id, { text: 'goodbye' });

        const t = textGeom(scene, id);
        expect(t.content).toBe('goodbye');
        expect(t.font_size, 'size must survive a content-only edit').toBe(24);
        expect(t.font_weight, 'weight must survive a content-only edit').toBe(700);
        expect(t.italic).toBe(true);
    });

    // The engine creates text with an EMPTY family, which falls back to
    // CanvasKit's RefDefault: not a sans-serif, and carrying no bold or italic
    // face — so weight and slant silently do nothing and the agent sees a
    // render that contradicts what it asked for.
    it('assigns a real font family so weight and slant have faces to select', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createText(10, 10, 'hello', 24);
        expect(textGeom(scene, id).font_family).toBe('Inter');
    });

    it('records weight and italic on the node', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createText(10, 10, 'hello', 24);
        agent.setText(id, { weight: 700, italic: true });
        const t = textGeom(scene, id);
        expect(t.font_weight).toBe(700);
        expect(t.italic).toBe(true);
    });

    it('sets alignment by name rather than a magic number', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createText(0, 0, 'x', 16);
        agent.setText(id, { align: 'center' });
        expect(textGeom(scene, id).text_align).toBe(1);
    });

    it('is one undo step even when it touches all three engine setters', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createText(0, 0, 'x', 16);
        const before = snapshot(scene);
        agent.setText(id, { text: 'y', fontSize: 32, align: 'right', weight: 700 });
        scene.undo();
        expect(snapshot(scene)).toEqual(before);
    });

    it('refuses to apply text edits to a non-text node', () => {
        const { agent } = makeAgent();
        const rect = agent.createRect(0, 0, 10, 10);
        expect(() => agent.setText(rect, { text: 'nope' })).toThrow(/not Text/);
    });
});

describe('agent API — text bounds under a transform', () => {
    /**
     * measureText reports the typeset size in the node's OWN local units, while
     * a node's x/y come from the world-space AABB. Reporting the two together
     * unscaled means a text node under a scaled group claims a width it does
     * not occupy — and right-aligning by that number, the exact use case
     * measurement exists for, lands short by the scale factor.
     */
    it('scales a measured width by the node’s world transform', () => {
        const scene = new WasmScene({} as never);
        scene.engine = new Engine();
        scene.history = new History(50);
        scene.wasm = wasm;
        const agent = createAgentApi({
            scene,
            ck: {} as never,
            getSelection: () => [],
            setSelection: () => {},
            exportSVG: () => '<svg/>',
            importSVG: async () => [],
            renderPNG: async () => '',
            ensureFont: () => {},
            // A fixed 100×20 stands in for a real typeset measurement.
            measureText: () => ({ width: 100, height: 20 }),
            fontsReady: async () => {},
        });

        const id = agent.createText(0, 0, 'hello', 16);
        return agent.describeNode(id).then(async (before) => {
            expect(before!.bounds[2]).toBeCloseTo(100, 1);

            // Scale the node the way an enclosing group's transform would.
            scene.setNodeScale(id, 2, 2);
            const after = await agent.describeNode(id);
            expect(after!.bounds[2], 'width must follow the transform').toBeCloseTo(200, 0);
            expect(after!.bounds[3], 'height must follow the transform').toBeCloseTo(40, 0);
        });
    });
});

describe('agent API — clear', () => {
    it('empties the canvas in a single undo step', async () => {
        const { agent, scene } = makeAgent();
        agent.createRect(0, 0, 10, 10);
        agent.createEllipse(50, 50, 10, 10);
        const before = snapshot(scene);

        agent.clear();
        expect((await agent.describe()).nodes).toHaveLength(0);

        scene.undo();
        expect(snapshot(scene), 'clear must be recoverable with one undo').toEqual(before);
    });

    it('is a no-op on an already-empty canvas', () => {
        const { agent } = makeAgent();
        expect(() => agent.clear()).not.toThrow();
    });
});

describe('agent API — importSVG', () => {
    it('rejects input that is not an SVG document', () => {
        const { agent } = makeAgent();
        return expect(agent.importSVG('just some text')).rejects.toThrow(/expects an <svg>/);
    });
});

/**
 * `describe` reports a node's BOUNDS, so that is the corner `setPosition` has
 * to take. It used to set the transform origin, which is the top-left only for
 * a rectangle: handing an ellipse or a star back the position just read for it
 * shoved it half its own size across the canvas.
 */
describe('agent API — position round trip', () => {
    for (const [what, make] of [
        ['a rect', (a: AgentApi) => a.createRect(100, 100, 40, 40)],
        ['an ellipse', (a: AgentApi) => a.createEllipse(100, 100, 50, 30)],
        ['a star', (a: AgentApi) => a.createStar(200, 200, 60, 30, 5)],
        ['a polygon', (a: AgentApi) => a.createPolygon(200, 200, 50, 6)],
    ] as const) {
        it(`setting ${what} to the position describe reports leaves it put`, async () => {
            const { agent } = makeAgent();
            const id = make(agent);
            const before = (await agent.describeNode(id))!.bounds;
            agent.setPosition(id, before[0], before[1]);
            const after = (await agent.describeNode(id))!.bounds;
            expect(after).toEqual(before);
        });
    }

    it('and moves it exactly where asked', async () => {
        const { agent } = makeAgent();
        const id = agent.createEllipse(100, 100, 50, 30);
        agent.setPosition(id, 0, 0);
        expect((await agent.describeNode(id))!.bounds.slice(0, 2)).toEqual([0, 0]);
    });
});

describe('agent API — resize reaches every kind of node', () => {
    it('a text node scales its type instead of ignoring the call', async () => {
        // Text is auto-width, so the engine's resize is a no-op for it: asking
        // to resize a text node did nothing and reported nothing.
        const { agent } = makeAgent();
        const id = agent.createText(0, 100, 'Hello there', 20);
        const before = (await agent.describeNode(id))!.bounds;
        agent.resize(id, before[2] * 2, before[3] * 2);
        const after = (await agent.describeNode(id))!.bounds;
        expect(after[2]).toBeGreaterThan(before[2]);
        expect(after[3]).toBeGreaterThan(before[3]);
    });
});

describe('agent API — styling', () => {
    it('setStroke preserves width when only the colour changes', async () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10);
        agent.setStroke(id, '#000000', 7);
        agent.setStroke(id, '#ffffff');
        const node = await agent.describeNode(id);
        expect(node?.strokeWidth).toBe(7);
        expect(node?.stroke).toBe('#ffffff');
    });

    it('a stroke width with no colour still paints something visible', async () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10, { strokeWidth: 3 });
        const node = await agent.describeNode(id);
        expect(node?.strokeWidth).toBe(3);
        expect(node?.stroke, 'width-only stroke should default to black').toBe('#000000');
    });
});

/**
 * The API speaks WORLD units — that is what describe_scene reports and what
 * the canvas shows. Inside a group carrying a transform (an imported SVG's, or
 * a group that has been resized) move/setPosition/resize used to write those
 * numbers straight into the node's local space, so a move went the wrong
 * distance and a resize came out the wrong size.
 */
describe('agent API — inside a transformed group', () => {
    /** A group scaled to 200%, holding `a`, which is 80×80 on the canvas. */
    function scaledGroup() {
        const { agent, scene } = makeAgent();
        const a = agent.createRect(0, 0, 40, 40);
        const b = agent.createRect(60, 0, 40, 40);
        const g = agent.group([a, b]);
        scene.setNodeTransformComponents(g, {
            x: 0,
            y: 0,
            scale_x: 2,
            scale_y: 2,
            rotation_deg: 0,
            skew_x_deg: 0,
            skew_y_deg: 0,
        });
        return { agent, scene, a, g };
    }
    const box = (scene: WasmScene, id: number) => Array.from(scene.getNodeBounds(id));

    it('move travels the distance it was given', () => {
        const { agent, scene, a } = scaledGroup();
        expect(box(scene, a)).toEqual([0, 0, 80, 80]);
        agent.move([a], 100, 0);
        expect(box(scene, a)).toEqual([100, 0, 180, 80]);
    });

    it('setPosition lands the shape on the point it was given', () => {
        const { agent, scene, a } = scaledGroup();
        agent.setPosition(a, 300, 300);
        expect(box(scene, a).slice(0, 2)).toEqual([300, 300]);
    });

    it('resize gives the size it was asked for', () => {
        const { agent, scene, a } = scaledGroup();
        agent.resize(a, 120, 60);
        const b = box(scene, a);
        expect([b[2] - b[0], b[3] - b[1]]).toEqual([120, 60]);
    });
});
