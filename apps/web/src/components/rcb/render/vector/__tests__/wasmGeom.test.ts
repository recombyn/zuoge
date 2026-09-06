import { describe, expect, it, beforeEach } from 'vitest';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { densifyPathDJs, splitPolylineContours } from '@/components/rcb/render/vector/densifyPathDJs';
import { tessellateFill, tessellateFillWithHoles } from '@/components/rcb/render/vector/tessellateFill';
import { tessellateStroke } from '@/components/rcb/render/vector/tessellateStroke';
import {
  __setWasmGeomApiForTests,
  densifyPathDWasm,
  tessellateFillWasm,
  tessellateStrokeWasm,
  tessellateFillWithHolesWasm,
  tessellateBatchFill,
  getWasmGeomBackend,
  setWasmGeomForceJs,
  initWasmGeom,
  buildShapeMeshes,
  buildCompoundFillMeshes,
} from '@/components/rcb/render/vector/wasmGeom';
import {
  clearShapeMeshCache,
  getOrBuildShapeMesh,
} from '@/components/rcb/render/vector/meshCache';
import {
  resetGeomProfile,
  setGeomProfileEnabled,
  getGeomProfileSnapshot,
  isGeomProfileEnabled,
} from '@/components/rcb/render/vector/geomProfile';

function almostEqualFlat(a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-3) {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i += 1) {
    expect(Math.abs(Number(a[i]) - Number(b[i]))).toBeLessThanOrEqual(eps);
  }
}

describe('wasm geom adapter', () => {
  beforeEach(() => {
    __setWasmGeomApiForTests(null);
    setWasmGeomForceJs(false);
    clearShapeMeshCache();
    resetGeomProfile();
    setGeomProfileEnabled(false);
  });

  it('falls back to JS densify/fill/stroke when wasm missing', () => {
    expect(getWasmGeomBackend()).toBe('js');
    const d = 'M0 0 H40 V30 H0 Z';
    const js = densifyPathDJs(d);
    const via = densifyPathDWasm(d);
    expect(via).toEqual(js);
    const fill = tessellateFillWasm([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(fill).not.toBeNull();
    expect(fill!.triangleCount).toBeGreaterThanOrEqual(2);
  });

  it('mock wasm API matches JS fill triangle count', () => {
    __setWasmGeomApiForTests({
      densify_path_d: (d) => {
        const pts = densifyPathDJs(d);
        const flat = new Float32Array(pts.length * 2);
        pts.forEach((p, i) => {
          flat[i * 2] = p.x;
          flat[i * 2 + 1] = p.y;
        });
        return flat;
      },
      tessellate_fill: (xy) => {
        const pts = [];
        for (let i = 0; i < xy.length; i += 2) pts.push({ x: xy[i]!, y: xy[i + 1]! });
        const m = tessellateFill(pts);
        return m ? m.positions : new Float32Array(0);
      },
      tessellate_fill_with_holes: (outer, holesFlat, holeCounts) => {
        const o = [];
        for (let i = 0; i < outer.length; i += 2) o.push({ x: outer[i]!, y: outer[i + 1]! });
        const holes = [];
        let off = 0;
        for (let h = 0; h < holeCounts.length; h += 1) {
          const n = holeCounts[h]!;
          const ring = [];
          for (let i = 0; i < n; i += 1) {
            ring.push({ x: holesFlat[off]!, y: holesFlat[off + 1]! });
            off += 2;
          }
          holes.push(ring);
        }
        const m = tessellateFillWithHoles(o, holes);
        return m ? m.positions : new Float32Array(0);
      },
      tessellate_stroke: (xy, width, closed, align, linejoin?: string, miterLimit?: number) => {
        const pts = [];
        for (let i = 0; i < xy.length; i += 2) pts.push({ x: xy[i]!, y: xy[i + 1]! });
        const m = tessellateStroke(pts, {
          width,
          closed,
          align,
          linejoin: (linejoin as 'miter' | 'round' | 'bevel') || 'miter',
          miterLimit: miterLimit || 100,
        });
        return m ? m.positions : new Float32Array(0);
      },
      tessellate_batch_fill: (xyAll, counts) => {
        const out: number[] = [];
        let off = 0;
        for (let c = 0; c < counts.length; c += 1) {
          const n = counts[c]!;
          const pts = [];
          for (let i = 0; i < n; i += 1) {
            pts.push({ x: xyAll[off]!, y: xyAll[off + 1]! });
            off += 2;
          }
          const m = tessellateFill(pts);
          const flat = m ? Array.from(m.positions) : [];
          out.push(flat.length, ...flat);
        }
        return new Float32Array(out);
      },
    });
    expect(getWasmGeomBackend()).toBe('wasm');
    const pts = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 0, y: 10 },
    ];
    const js = tessellateFill(pts)!;
    const wa = tessellateFillWasm(pts)!;
    almostEqualFlat(js.positions, wa.positions);
    const strokeJs = tessellateStroke(pts, { width: 2, closed: true })!;
    const strokeWa = tessellateStrokeWasm(pts, { width: 2, closed: true })!;
    almostEqualFlat(strokeJs.positions, strokeWa.positions);
  });

  it('tessellateFillWithHoles emits triangles for donut-like rings', () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const hole = [
      { x: 30, y: 30 },
      { x: 70, y: 30 },
      { x: 70, y: 70 },
      { x: 30, y: 70 },
    ];
    const mesh = tessellateFillWithHoles(outer, [hole]);
    expect(mesh).not.toBeNull();
    expect(mesh!.triangleCount).toBeGreaterThanOrEqual(2);
    const via = tessellateFillWithHolesWasm(outer, [hole]);
    expect(via).not.toBeNull();
    expect(via!.triangleCount).toBeGreaterThanOrEqual(1);
  });

  it('falls back to JS when wasm hole fill returns empty (shipped keyhole bug)', () => {
    __setWasmGeomApiForTests({
      densify_path_d: () => new Float32Array(0),
      tessellate_fill: () => new Float32Array(0),
      // Shipped wasm keyhole path is broken; fillMeshFor must ignore it for holes.
      tessellate_fill_with_holes: () => new Float32Array(0),
      tessellate_stroke: () => new Float32Array(0),
      tessellate_batch_fill: () => new Float32Array(0),
    });
    expect(getWasmGeomBackend()).toBe('wasm');
    const via = tessellateFillWithHolesWasm(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
      [
        [
          { x: 30, y: 30 },
          { x: 70, y: 30 },
          { x: 70, y: 70 },
          { x: 30, y: 70 },
        ],
      ]
    );
    expect(via?.triangleCount ?? 0).toBeGreaterThan(2);

    const pts = densifyPathDJs('M0 0H100V100H0Z M30 30H70V70H30Z', 0.5);
    const shaped = buildShapeMeshes(pts, {
      closed: true,
      wantFill: true,
      strokeWidth: 0,
      fillRule: 'evenodd',
    });
    expect(shaped.fill?.triangleCount ?? 0).toBeGreaterThan(2);
  });

  it('batch fill returns one mesh per ring', () => {
    const rings = [
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 5 },
      ],
      [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 8, y: 8 },
        { x: 0, y: 8 },
      ],
    ];
    const out = tessellateBatchFill(rings);
    expect(out).toHaveLength(2);
    expect(out[0]?.triangleCount).toBe(1);
    expect(out[1]?.triangleCount).toBeGreaterThanOrEqual(2);
  });

  it('geom profile records fill timing when enabled', () => {
    setGeomProfileEnabled(true);
    expect(isGeomProfileEnabled()).toBe(true);
    tessellateFillWasm([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ]);
    const snap = getGeomProfileSnapshot();
    expect(snap.samples).toBeGreaterThanOrEqual(1);
    expect(snap.fillMs).toBeGreaterThanOrEqual(0);
  });

  it('meshCache builds donut hole for ellipse with inner ratio', () => {
    const node = {
      id: 'donut',
      key: 'shape',
      width: 80,
      height: 80,
      attrs: {
        shapeType: 'ellipse',
        'fill-color': '#abc',
        'ellipse-inner-ratio': 0.4,
        'stroke-enabled': false,
      },
    } as SceneNodeInput;
    const mesh = getOrBuildShapeMesh('donut', node, { width: 80, height: 80 });
    expect(mesh?.fill).not.toBeNull();
    expect(mesh!.fill!.triangleCount).toBeGreaterThanOrEqual(4);
  });

  it('buildShapeMeshes nests multi-M path holes', () => {
    const d = 'M0 0H100V100H0Z M25 25H75V75H25Z';
    const pts = densifyPathDJs(d, 0.5);
    const runs = splitPolylineContours(pts);
    expect(runs.length).toBe(2);
    const compound = buildCompoundFillMeshes(pts, 'evenodd');
    expect(compound?.triangleCount ?? 0).toBeGreaterThan(2);
    const shaped = buildShapeMeshes(pts, {
      closed: true,
      wantFill: true,
      strokeWidth: 0,
      fillRule: 'evenodd',
    });
    expect(shaped.fill?.triangleCount ?? 0).toBeGreaterThan(2);
  });

  it('meshCache punches evenodd path hole (boolean subtract look)', () => {
    // Outer square + inner square — must not paint as a solid outer-only plate.
    const node = {
      id: 'bool-hole',
      key: 'shape',
      width: 100,
      height: 100,
      attrs: {
        shapeType: 'path',
        path: 'M0 0H100V100H0Z M25 25H75V75H25Z',
        closed: 'true',
        'fill-rule': 'evenodd',
        'fill-color': '#ffffff',
        'stroke-enabled': false,
      },
    } as SceneNodeInput;
    const punched = getOrBuildShapeMesh('bool-hole', node, { width: 100, height: 100 });
    expect(punched?.fill).not.toBeNull();
    // Solid AABB ear-clip is typically 2 tris; a punched ring must be denser.
    // If compound nesting never ran, triangleCount stays at 2.
    expect(punched!.fill!.triangleCount).toBeGreaterThan(2);
    // Positions must leave the hole empty: no triangle covers the hole center.
    const pos = punched!.fill!.positions;
    const hx = 50;
    const hy = 50;
    let coversHole = false;
    for (let i = 0; i + 5 < pos.length; i += 6) {
      const x0 = pos[i]!;
      const y0 = pos[i + 1]!;
      const x1 = pos[i + 2]!;
      const y1 = pos[i + 3]!;
      const x2 = pos[i + 4]!;
      const y2 = pos[i + 5]!;
      // Barycentric inside test
      const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (Math.abs(d) < 1e-9) continue;
      const a = ((y1 - y2) * (hx - x2) + (x2 - x1) * (hy - y2)) / d;
      const b = ((y2 - y0) * (hx - x2) + (x0 - x2) * (hy - y2)) / d;
      const c = 1 - a - b;
      if (a >= -1e-4 && b >= -1e-4 && c >= -1e-4) {
        coversHole = true;
        break;
      }
    }
    expect(coversHole).toBe(false);
  });

  it('initWasmGeom resolves false without pkg', async () => {
    setWasmGeomForceJs(true);
    await expect(initWasmGeom()).resolves.toBe(false);
  });
});
