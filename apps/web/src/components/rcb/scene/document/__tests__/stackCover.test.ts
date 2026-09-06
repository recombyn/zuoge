import { describe, expect, it } from 'vitest';
import {
  addNodeToDocument,
  buildNodeStackZMap,
  createBareDocument,
  maxDocumentStackZ,
  nodePaintZIndex,
  reorderNodesInDocument,
  selectionPaintZIndex,
  listSingleSelectionPaintRaiseNodeIds,
  stackZIndex,
  worldNodeStacksAboveAnyFrame,
} from '../sceneDocument';
import {
  createImageGeneratorNode
} from '../nodeFactories';
import {
  findHtmlMediaMount,
  HTML_MEDIA_MOUNT_ATTR,
  nodeToSvgElement,
} from '../../paint/sceneToSvg';

function svgRoot(attrs: Record<string, string> = {}) {
  const root = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  root.setAttribute('data-rcb-infinite', '1');
  root.setAttribute('data-rcb-shared-scene-surface', '1');
  for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
  const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  root.appendChild(layer);
  document.body.appendChild(root);
  return { root, layer };
}

describe('unified HTML media stack (foreignObject)', () => {
  it('keeps frame children out of the world stack and orders them locally', () => {
    let doc = createBareDocument();
    doc.frames = [
      { id: 'frame-a', name: 'A', backgroundColor: '#fff', x: 0, y: 0, width: 300, height: 200 },
      { id: 'frame-b', name: 'B', backgroundColor: '#fff', x: 400, y: 0, width: 300, height: 200 },
    ];
    doc = addNodeToDocument(doc, 'a0', {
      id: 'a0', key: 'rect', x: 10, y: 10, width: 20, height: 20,
      attrs: { frameId: 'frame-a' }, children: [],
    });
    doc = addNodeToDocument(doc, 'a1', {
      id: 'a1', key: 'rect', x: 40, y: 10, width: 20, height: 20,
      attrs: { frameId: 'frame-a' }, children: [],
    });
    doc = addNodeToDocument(doc, 'world', {
      id: 'world', key: 'rect', x: 800, y: 10, width: 20, height: 20,
      attrs: {}, children: [],
    });

    expect(doc.stackOrder).toEqual(['frame:frame-a', 'frame:frame-b', 'node:world']);
    expect(doc.deltaSetLike.a0.attrs.frameOrder).toBe(0);
    expect(doc.deltaSetLike.a1.attrs.frameOrder).toBe(1);
    expect(stackZIndex(doc, 'node', 'a1')).toBeGreaterThan(stackZIndex(doc, 'node', 'a0'));
    const zMap = buildNodeStackZMap(doc, ['a0', 'a1', 'world']);
    expect(zMap.get('a1')!).toBeGreaterThan(zMap.get('a0')!);
    expect(zMap.get('a0')).toBe(stackZIndex(doc, 'node', 'a0'));
    expect(zMap.get('a1')).toBe(stackZIndex(doc, 'node', 'a1'));
    expect(zMap.get('world')).toBe(stackZIndex(doc, 'node', 'world'));

    doc = reorderNodesInDocument(doc, ['a0'], 'front');
    expect(doc.deltaSetLike.a0.attrs.frameOrder).toBe(1);
    expect(doc.deltaSetLike.a1.attrs.frameOrder).toBe(0);
    expect(doc.stackOrder).not.toContain('node:a0');
  });

  it('selection paint raise uses current canvas max + 1 without mutating stackOrder', () => {
    let doc = createBareDocument();
    doc.frames = [
      { id: 'low', name: 'L', backgroundColor: '#fff', x: 0, y: 0, width: 100, height: 100 },
      { id: 'high', name: 'H', backgroundColor: '#fff', x: 50, y: 50, width: 100, height: 100 },
    ];
    doc.stackOrder = ['frame:low', 'frame:high'];
    doc = addNodeToDocument(doc, 'back', {
      id: 'back',
      key: 'rect',
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      attrs: {},
      children: [],
    });
    const maxZ = maxDocumentStackZ(doc);
    expect(maxZ).toBeGreaterThan(0);
    const raised = selectionPaintZIndex(doc, 'frame', 'low', true);
    expect(raised).toBe(maxZ + 1);
    expect(selectionPaintZIndex(doc, 'frame', 'low', false)).toBe(stackZIndex(doc, 'frame', 'low'));
    expect(selectionPaintZIndex(doc, 'node', 'back', true)).toBe(maxZ + 1);
    expect(doc.stackOrder).toEqual(['frame:low', 'frame:high', 'node:back']);
  });

  it('raised frame children stay above the raised plate (in-frame local slots)', () => {
    let doc = createBareDocument();
    doc.frames = [
      { id: 'f1', name: 'F', backgroundColor: '#fff', x: 0, y: 0, width: 200, height: 200 },
    ];
    doc.stackOrder = ['frame:f1'];
    doc = addNodeToDocument(doc, 'c0', {
      id: 'c0',
      key: 'rect',
      x: 10,
      y: 10,
      width: 40,
      height: 40,
      attrs: { frameId: 'f1', frameOrder: 0 },
      children: [],
    });
    doc = addNodeToDocument(doc, 'c1', {
      id: 'c1',
      key: 'rect',
      x: 20,
      y: 20,
      width: 40,
      height: 40,
      attrs: { frameId: 'f1', frameOrder: 1 },
      children: [],
    });
    const plateRaised = selectionPaintZIndex(doc, 'frame', 'f1', true);
    const c0Raised = selectionPaintZIndex(doc, 'node', 'c0', true);
    const c1Raised = selectionPaintZIndex(doc, 'node', 'c1', true);
    expect(c0Raised).toBeGreaterThan(plateRaised);
    expect(c1Raised).toBeGreaterThan(c0Raised);
  });

  it('single-selection paint raise lists only one node or one frame children', () => {
    let doc = createBareDocument();
    doc.frames = [
      { id: 'f1', name: 'F', backgroundColor: '#fff', x: 0, y: 0, width: 100, height: 100 },
    ];
    doc.stackOrder = ['frame:f1'];
    doc = addNodeToDocument(doc, 'c1', {
      id: 'c1',
      key: 'rect',
      x: 0,
      y: 0,
      width: 20,
      height: 20,
      attrs: { frameId: 'f1' },
      children: [],
    });
    doc = addNodeToDocument(doc, 'w1', {
      id: 'w1',
      key: 'rect',
      x: 200,
      y: 0,
      width: 20,
      height: 20,
      attrs: {},
      children: [],
    });
    expect(listSingleSelectionPaintRaiseNodeIds(doc, ['w1'], [])).toEqual(['w1']);
    expect(listSingleSelectionPaintRaiseNodeIds(doc, ['w1', 'c1'], [])).toEqual([]);
    expect(listSingleSelectionPaintRaiseNodeIds(doc, [], ['f1'])).toEqual(['c1']);
    expect(listSingleSelectionPaintRaiseNodeIds(doc, [], ['f1', 'f2'])).toEqual([]);
    // World node after the artboard in stackOrder must leave SoA (under plates).
    expect(worldNodeStacksAboveAnyFrame(doc, 'w1')).toBe(true);
    expect(worldNodeStacksAboveAnyFrame(doc, 'c1')).toBe(false);
  });

  it('workbench surround above a plate is not stack-above (stays SoA mesh)', () => {
    let doc = createBareDocument();
    doc.frames = [
      { id: 'anim', name: 'Animation', backgroundColor: '#fff', x: 0, y: 0, width: 100, height: 100 },
    ];
    doc.stackOrder = ['frame:anim'];
    doc = addNodeToDocument(doc, 's1', {
      id: 's1',
      key: 'rect',
      x: 200,
      y: 0,
      width: 20,
      height: 20,
      attrs: { animationWorkbenchSurround: 'anim' },
      children: [],
    });
    expect(worldNodeStacksAboveAnyFrame(doc, 's1')).toBe(false);
  });

  it('world node below all frames can stay on SoA', () => {
    let doc = createBareDocument();
    doc = addNodeToDocument(doc, 'under', {
      id: 'under',
      key: 'rect',
      x: 0,
      y: 0,
      width: 20,
      height: 20,
      attrs: {},
      children: [],
    });
    doc.frames = [
      { id: 'top', name: 'T', backgroundColor: '#fff', x: 0, y: 0, width: 100, height: 100 },
    ];
    doc.stackOrder = ['node:under', 'frame:top'];
    expect(worldNodeStacksAboveAnyFrame(doc, 'under')).toBe(false);
  });

  it('empty world generator paints above artboard plates without mutating stackOrder', () => {
    let doc = createBareDocument();
    const { id, node } = createImageGeneratorNode({ x: 50, y: 50, width: 80, height: 80 });
    doc = addNodeToDocument(doc, id, node);
    doc.frames = [
      { id: 'board', name: 'Frame', backgroundColor: '#fff', x: 0, y: 0, width: 200, height: 300 },
    ];
    // Generator under the plate in permanent order (paste-then-frame / older stack).
    doc.stackOrder = [`node:${id}`, 'frame:board'];
    const plateZ = stackZIndex(doc, 'frame', 'board');
    const natural = stackZIndex(doc, 'node', id);
    expect(natural).toBeLessThan(plateZ);
    const paintZ = nodePaintZIndex(doc, id, false);
    expect(paintZ).toBeGreaterThan(plateZ);
    expect(doc.stackOrder).toEqual([`node:${id}`, 'frame:board']);

    const bound = createImageGeneratorNode({ x: 10, y: 10, width: 40, height: 40 });
    bound.node.attrs = { ...bound.node.attrs, frameId: 'board', frameOrder: 0 };
    doc = addNodeToDocument(doc, bound.id, bound.node);
    expect(nodePaintZIndex(doc, bound.id, false)).toBe(stackZIndex(doc, 'node', bound.id));
  });

  it('addNodeToDocument appends new nodes on top of stackOrder', () => {
    let doc = createBareDocument();
    doc = addNodeToDocument(doc, 'lot1', {
      id: 'lot1',
      key: 'lottie',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      attrs: { animationData: '{}' },
      children: [],
    });
    const { id, node } = createImageGeneratorNode({ x: 50, y: 50, width: 80, height: 80 });
    doc = addNodeToDocument(doc, id, node);
    expect(stackZIndex(doc, 'node', id)).toBeGreaterThan(stackZIndex(doc, 'node', 'lot1'));
    expect(doc.stackOrder[doc.stackOrder.length - 1]).toBe(`node:${id}`);
  });

  it('lottie with animationData paints a foreignObject HTML mount in the SVG layer', async () => {
    const { root, layer } = svgRoot();
    const anim = JSON.stringify({ v: '5.7.0', fr: 30, ip: 0, op: 30, w: 100, h: 100, layers: [] });
    const el = await nodeToSvgElement(
      root,
      layer,
      { x: 0, y: 0, deltaSetLike: {} },
      {
        key: 'lottie',
        x: 10,
        y: 20,
        width: 80,
        height: 60,
        attrs: { animationData: anim, 'fill-color': '#FFFFFF' },
      },
      'lot1'
    );
    expect(el).toBeTruthy();
    const fo = el!.querySelector('svg[data-rcb-lottie-svg-ink="1"]');
    expect(fo).toBeTruthy();
    expect(el!.querySelector('foreignObject[data-rcb-html-media-fo="lottie"]')).toBeNull();
    const mount = el!.querySelector(`[${HTML_MEDIA_MOUNT_ATTR}="lot1"]`);
    expect(mount).toBeTruthy();
    expect(findHtmlMediaMount('lot1')).toBe(mount);
    root.remove();
  });

  it('workbench nested lottie has no opaque SVG plate fill', async () => {
    const { root, layer } = svgRoot();
    const anim = JSON.stringify({ v: '5.7.0', fr: 30, ip: 0, op: 30, w: 100, h: 100, layers: [] });
    const doc = {
      x: 0,
      y: 0,
      deltaSetLike: {},
      frames: [{ id: 'af1', kind: 'animation', x: 0, y: 0, width: 200, height: 200 }],
    };
    const el = await nodeToSvgElement(
      root,
      layer,
      doc,
      {
        key: 'lottie',
        x: 10,
        y: 20,
        width: 80,
        height: 60,
        attrs: { animationData: anim, frameId: 'af1', 'fill-color': '#FFFFFF' },
      },
      'lot-nested'
    );
    expect(el).toBeTruthy();
    const plate = el!.querySelector('[data-radius-body="1"]');
    expect(plate?.getAttribute('fill')).toBe('none');
    root.remove();
  });

  it('export surface does not mount lottie SVG ink mount', async () => {
    const { root, layer } = svgRoot({ 'data-rcb-export-surface': '1' });
    const anim = JSON.stringify({ v: '5.7.0', fr: 30, ip: 0, op: 30, w: 100, h: 100, layers: [] });
    const el = await nodeToSvgElement(
      root,
      layer,
      { x: 0, y: 0, deltaSetLike: {} },
      {
        key: 'lottie',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: { animationData: anim },
      },
      'lot2'
    );
    expect(el!.querySelector('foreignObject[data-rcb-html-media-fo]')).toBeNull();
    expect(el!.querySelector('svg[data-rcb-lottie-svg-ink="1"]')).toBeNull();
    root.remove();
  });

  it('video with src mounts foreignObject on world surface', async () => {
    const { root, layer } = svgRoot();
    const el = await nodeToSvgElement(
      root,
      layer,
      { x: 0, y: 0, deltaSetLike: {} },
      {
        key: 'video',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: { src: 'https://example.com/a.mp4', poster: 'https://example.com/p.jpg' },
      },
      'vid1'
    );
    expect(el!.querySelector('foreignObject[data-rcb-html-media-fo="video"]')).toBeTruthy();
    root.remove();
  });
});
