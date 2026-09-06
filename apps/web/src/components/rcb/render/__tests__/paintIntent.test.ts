import { describe, expect, it } from 'vitest';
import {
  backingInsufficientForAtlas,
  resolvePaintIntent,
} from '@/components/rcb/render/paintIntent';
import { createEmptyDocument, addNodeToDocument } from '@/components/rcb/scene/document/sceneDocument';

describe('paintIntent', () => {
  it('routes idle images to gpu-mesh textured media (never DomHost-for-blur)', () => {
    let doc = createEmptyDocument();
    doc = addNodeToDocument(doc, 'img', {
      id: 'img',
      key: 'image',
      x: 0,
      y: 0,
      width: 600,
      height: 400,
      attrs: { src: 'https://example.com/a.png' },
    } as any);
    const intent = resolvePaintIntent(doc, 'img', doc.deltaSetLike!.img, {
      zoom: 8,
      dpr: 1,
    });
    expect(intent.kind).toBe('gpu-mesh');
    expect(backingInsufficientForAtlas(doc.deltaSetLike!.img, 8, 1)).toBe(true);
  });

  it('routes plate raise to dom-obligatory', () => {
    let doc = createEmptyDocument();
    doc = addNodeToDocument(doc, 'r', {
      id: 'r',
      key: 'rect',
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      attrs: { frameId: 'board', fill: '#f00' },
    } as any);
    doc = {
      ...doc,
      frames: [
        {
          id: 'board',
          name: 'A',
          backgroundColor: '#fff',
          x: 0,
          y: 0,
          width: 200,
          height: 200,
        },
      ],
    };
    const intent = resolvePaintIntent(doc, 'r', doc.deltaSetLike!.r, {
      zoom: 1,
      dpr: 1,
      raised: true,
    });
    expect(intent).toEqual({ kind: 'dom-obligatory', reason: 'plate-raise' });
  });
});
