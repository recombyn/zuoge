import { describe, expect, it } from 'vitest';
import {
  applyFrameContentClip,
  findClippingFrameForNode,
  syncFrameContentClip,
} from '../frameContentClip';
import {
  clearLiveArtboardFrameGeometry,
  previewArtboardFrameGeometry,
} from '../HtmlArtboardFrame';
import {
  clearNodeTransformPreviews,
  setNodeTransformPreviews,
} from '@/components/rcb/core/transformPreview';

describe('frame content clipping', () => {
  it('treats undefined clipContent as on (default)', () => {
    const frame = {
      id: 'frame-1',
      name: 'Frame',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      hidden: false,
      backgroundColor: '#fff',
    };
    const found = findClippingFrameForNode(
      { frames: [frame] },
      { attrs: { frameId: 'frame-1' } }
    );
    expect(found?.id).toBe('frame-1');
    expect(
      findClippingFrameForNode(
        { frames: [{ ...frame, clipContent: false }] },
        { attrs: { frameId: 'frame-1' } }
      )
    ).toBeNull();
  });

  it('keeps plate clip while frameId is set, even when AABB is outside the plate', () => {
    const root = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.setAttribute('data-rcb-shape-id', 'n1');
    layer.setAttribute('data-rcb-shape-layer', '1');
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    root.append(layer);
    layer.append(node);

    const frame = {
      id: 'frame-1',
      name: 'Frame',
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      clipContent: true,
      hidden: false,
      backgroundColor: '#fff',
    };

    applyFrameContentClip(
      root,
      node,
      { frames: [frame] },
      {
        x: 120,
        y: 120,
        width: 40,
        height: 40,
        attrs: { frameId: 'frame-1' },
      }
    );
    expect(node.parentElement).toBe(layer);
    expect(root.querySelector('[data-frame-clip-wrap="1"]')).toBeNull();
    expect(layer.getAttribute('clip-path') || '').toContain('url(');
    expect(node.hasAttribute('clip-path')).toBe(false);

    const clipRef1 = layer.getAttribute('clip-path');
    const clipId1 = layer.getAttribute('data-rcb-frame-clip');

    // Still bound — clip stays (ink must not spill onto the pasteboard).
    applyFrameContentClip(
      root,
      node,
      { frames: [frame] },
      {
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: { frameId: 'frame-1' },
      }
    );
    expect(layer.getAttribute('clip-path') || '').toContain('url(');
    // Same clipPath id — reminting url(#…) every call shakes the clipped edge.
    expect(layer.getAttribute('clip-path')).toBe(clipRef1);
    expect(layer.getAttribute('data-rcb-frame-clip')).toBe(clipId1);
    expect(root.querySelectorAll('clipPath').length).toBe(1);

    // Unbound — clip clears.
    applyFrameContentClip(
      root,
      node,
      { frames: [frame] },
      {
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: {},
      }
    );
    expect(layer.hasAttribute('clip-path')).toBe(false);
    expect(node.hasAttribute('clip-path')).toBe(false);
  });

  it('unwraps a legacy clip wrap so mix-blend-mode can composite again', () => {
    const root = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.setAttribute('data-rcb-shape-id', 'n1');
    const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    wrap.setAttribute('data-frame-clip-wrap', '1');
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    root.append(layer);
    layer.append(wrap);
    wrap.append(node);

    const frame = {
      id: 'frame-1',
      name: 'Frame',
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      clipContent: true,
      hidden: false,
      backgroundColor: '#fff',
    };

    applyFrameContentClip(
      root,
      node,
      { frames: [frame] },
      {
        x: 10,
        y: 10,
        width: 40,
        height: 40,
        attrs: { frameId: 'frame-1' },
      }
    );

    expect(node.parentElement).toBe(layer);
    expect(root.querySelector('[data-frame-clip-wrap="1"]')).toBeNull();
    expect(layer.getAttribute('clip-path') || '').toContain('url(');
  });

  it('syncFrameContentClip clears clip when selection reveals overflow', () => {
    const root = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.setAttribute('data-rcb-shape-id', 'n1');
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    root.append(layer);
    layer.append(node);

    const frame = {
      id: 'frame-1',
      name: 'Frame',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      clipContent: true,
      hidden: false,
      backgroundColor: '#fff',
    };
    const sceneNode = {
      x: 80,
      y: 40,
      width: 40,
      height: 40,
      attrs: { frameId: 'frame-1' },
    };

    syncFrameContentClip(root, node, { frames: [frame] }, sceneNode, { revealOverflow: false });
    expect(layer.getAttribute('clip-path') || '').toContain('url(');

    syncFrameContentClip(root, node, { frames: [frame] }, sceneNode, { revealOverflow: true });
    expect(layer.hasAttribute('clip-path')).toBe(false);
  });

  it('syncFrameContentClip still works when board.root is null via shared scene root', () => {
    // Mirrors infinite canvas: session must clip through getSceneWorldRoot, not board.root.
    const root = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.setAttribute('data-rcb-shape-id', 'bool-1');
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    root.append(layer);
    layer.append(node);

    const frame = {
      id: 'frame-1',
      name: 'Frame',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      clipContent: true,
      hidden: false,
      backgroundColor: '#fff',
    };
    const sceneNode = {
      x: 40,
      y: 40,
      width: 80,
      height: 80,
      attrs: { frameId: 'frame-1', 'fill-rule': 'evenodd' },
    };

    // null board root — caller must pass shared world root (regression for clip runaway).
    syncFrameContentClip(null, node, { frames: [frame] }, sceneNode, { revealOverflow: false });
    expect(layer.hasAttribute('clip-path')).toBe(false);

    syncFrameContentClip(root, node, { frames: [frame] }, sceneNode, { revealOverflow: false });
    expect(layer.getAttribute('clip-path') || '').toContain('url(');

    previewArtboardFrameGeometry({ id: 'frame-1', x: 50, y: 0, width: 100, height: 100 });
    syncFrameContentClip(root, node, { frames: [frame] }, sceneNode, { revealOverflow: false });
    const clipRect = root.querySelector('clipPath rect');
    expect(Number(clipRect?.getAttribute('x'))).toBeGreaterThan(40);

    clearLiveArtboardFrameGeometry(['frame-1']);
  });

  it('clips to live artboard + TransformPreview during frame move (no spill)', () => {
    const root = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.setAttribute('data-rcb-shape-id', 'n1');
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    root.append(layer);
    layer.append(el);

    const frame = {
      id: 'frame-1',
      name: 'Frame',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      clipContent: true,
      hidden: false,
      backgroundColor: '#fff',
    };
    // Document still at pre-gesture coords; live plate + preview node already moved.
    previewArtboardFrameGeometry({ id: 'frame-1', x: 80, y: 40, width: 100, height: 100 });
    setNodeTransformPreviews([
      { nodeId: 'child-1', left: 100, top: 60, width: 40, height: 40 },
    ]);

    applyFrameContentClip(
      root,
      el,
      { frames: [frame] },
      {
        id: 'child-1',
        x: 20,
        y: 20,
        width: 40,
        height: 40,
        attrs: { frameId: 'frame-1' },
      }
    );
    expect(layer.getAttribute('clip-path') || '').toContain('url(');
    const clipRect = root.querySelector('clipPath rect');
    expect(clipRect?.getAttribute('x')).toBeTruthy();
    const clipX = Number(clipRect?.getAttribute('x'));
    // Live plate is at x=80 (minus inset) — not stale document x=0.
    expect(clipX).toBeGreaterThan(70);

    clearLiveArtboardFrameGeometry(['frame-1']);
    clearNodeTransformPreviews(['child-1']);
  });
});
