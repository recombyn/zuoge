import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import {
  __setWasmGeomApiForTests,
  setWasmGeomForceJs,
  getWasmGeomBackend,
} from '@/components/rcb/render/vector/wasmGeom';
import { getOrBuildShapeMesh, clearShapeMeshCache } from '@/components/rcb/render/vector/meshCache';

function covers(pos: Float32Array, hx: number, hy: number): boolean {
  for (let i = 0; i + 5 < pos.length; i += 6) {
    const ax = pos[i]!;
    const ay = pos[i + 1]!;
    const bx = pos[i + 2]!;
    const by = pos[i + 3]!;
    const cx = pos[i + 4]!;
    const cy = pos[i + 5]!;
    const v0x = cx - ax;
    const v0y = cy - ay;
    const v1x = bx - ax;
    const v1y = by - ay;
    const v2x = hx - ax;
    const v2y = hy - ay;
    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;
    const inv = 1 / (dot00 * dot11 - dot01 * dot01 + 1e-20);
    const u = (dot11 * dot02 - dot01 * dot12) * inv;
    const v = (dot00 * dot12 - dot01 * dot02) * inv;
    if (u >= 0 && v >= 0 && u + v <= 1) return true;
  }
  return false;
}

describe('donut fill with real wasm boolean holes', () => {
  beforeEach(() => {
    clearShapeMeshCache();
    setWasmGeomForceJs(false);
  });

  it('wasm hole path is hollow and covers the ring band', async () => {
    const wasmJs = pathToFileURL(
      'E:/Tianmeng/resume-creation-web/apps/web/public/rcb-wasm/rcb_wasm_geom.js'
    ).href;
    const mod = await import(/* @vite-ignore */ wasmJs);
    await mod.default({
      module_or_path: readFileSync(
        'E:/Tianmeng/resume-creation-web/apps/web/public/rcb-wasm/rcb_wasm_geom_bg.wasm'
      ),
    });
    __setWasmGeomApiForTests({
      densify_path_d: mod.densify_path_d,
      tessellate_fill: mod.tessellate_fill,
      tessellate_fill_with_holes: mod.tessellate_fill_with_holes,
      tessellate_stroke: mod.tessellate_stroke,
      tessellate_batch_fill: mod.tessellate_batch_fill,
    });
    expect(getWasmGeomBackend()).toBe('wasm');

    const node = {
      id: 'donut',
      key: 'shape',
      width: 200,
      height: 200,
      attrs: {
        shapeType: 'circle',
        'fill-color': '#ccc',
        ellipseInnerRatio: 0.42,
        'stroke-enabled': false,
      },
    } as SceneNodeInput;
    const mesh = getOrBuildShapeMesh('donut', node, { width: 200, height: 200 });
    expect(mesh?.fill?.triangleCount ?? 0).toBeGreaterThan(8);
    const pos = mesh!.fill!.positions;
    expect(covers(pos, 100, 100)).toBe(false);
    expect(covers(pos, 100, 30)).toBe(true);
  });

  it('falls back to JS when wasm hole mesh is skeletal', () => {
    __setWasmGeomApiForTests({
      densify_path_d: () => new Float32Array(0),
      tessellate_fill: () => new Float32Array(0),
      tessellate_fill_with_holes: () =>
        new Float32Array([100, 0, 186.6, 150, 13.4, 150]),
      tessellate_stroke: () => new Float32Array(0),
      tessellate_batch_fill: () => new Float32Array(0),
    });
    expect(getWasmGeomBackend()).toBe('wasm');
    const node = {
      id: 'donut-skel',
      key: 'shape',
      width: 200,
      height: 200,
      attrs: {
        shapeType: 'circle',
        'fill-color': '#ccc',
        ellipseInnerRatio: 0.42,
        'stroke-enabled': false,
      },
    } as SceneNodeInput;
    const mesh = getOrBuildShapeMesh('donut-skel', node, { width: 200, height: 200 });
    expect(mesh?.fill?.triangleCount ?? 0).toBeGreaterThan(8);
    expect(covers(mesh!.fill!.positions, 100, 100)).toBe(false);
    expect(covers(mesh!.fill!.positions, 100, 30)).toBe(true);
  });
});
