import { afterEach, describe, expect, it } from 'vitest';
import {
  clearShapeMeshCache,
  getOrBuildShapeMesh,
} from '@/components/rcb/render/vector/meshCache';
import {
  setLiveShapeParamsPreview,
} from '@/components/rcb/scene/document/sceneShapes';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';

afterEach(() => {
  setLiveShapeParamsPreview(null);
  clearShapeMeshCache();
});

describe('live polygon sides remesh', () => {
  it('getOrBuildShapeMesh picks up live sides before document commit', () => {
    const node: SceneNodeInput = {
      id: 'poly1',
      key: 'shape',
      width: 100,
      height: 100,
      attrs: {
        shapeType: 'polygon',
        sides: 5,
        'fill-color': '#ffffff',
        'stroke-enabled': false,
      },
      children: [],
    };
    const a = getOrBuildShapeMesh('poly1', node, { width: 100, height: 100 });
    expect(a?.fill?.triangleCount).toBeGreaterThan(0);
    const fp5 = a!.geomFp;

    setLiveShapeParamsPreview({ nodeId: 'poly1', sides: 3 });
    const b = getOrBuildShapeMesh('poly1', node, { width: 100, height: 100 });
    expect(b?.fill?.triangleCount).toBeGreaterThan(0);
    expect(b!.geomFp).not.toEqual(fp5);
    expect(b!.geomFp).toContain('3');
  });
});
