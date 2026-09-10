import { describe, expect, it } from 'vitest';
import { resolvePaintIntent } from '@/components/rcb/shapes/paintIntent';
import { createEmptyDocument, addNodeToDocument } from '@/components/rcb/scene/document/sceneDocument';

describe('paintIntent', () => {
  it('routes idle images to Kit (no SVG DomHost)', () => {
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
    expect(resolvePaintIntent(doc, 'img', doc.deltaSetLike!.img).kind).toBe('kit');
  });

  it('routes plate-bound vector raise to Kit (no SVG dual paint)', () => {
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
    expect(
      resolvePaintIntent(doc, 'r', doc.deltaSetLike!.r, { forceFull: true }).kind
    ).toBe('kit');
  });

  it('routes active video FO shell to DomHost (HTML decoder only)', () => {
    let doc = createEmptyDocument();
    doc = addNodeToDocument(doc, 'v', {
      id: 'v',
      key: 'video',
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      attrs: { src: 'https://example.com/a.mp4', poster: 'https://example.com/p.png' },
    } as any);
    expect(resolvePaintIntent(doc, 'v', doc.deltaSetLike!.v).kind).toBe('kit');
    expect(resolvePaintIntent(doc, 'v', doc.deltaSetLike!.v, { forceFull: true })).toEqual({
      kind: 'dom-host',
      reason: 'html-media-fo',
    });
  });

  it('routes SoftGlow process plates to Kit (upload / 图片分层 / …)', () => {
    let doc = createEmptyDocument();
    doc = addNodeToDocument(doc, 'img', {
      id: 'img',
      key: 'image',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      attrs: { src: 'https://example.com/a.png', processStatus: 'running' },
    } as any);
    expect(
      resolvePaintIntent(doc, 'img', doc.deltaSetLike!.img, { forceFull: true })
    ).toEqual({ kind: 'kit' });
  });

  it('routes lottie and group to DomHost', () => {
    let doc = createEmptyDocument();
    doc = addNodeToDocument(doc, 'l', {
      id: 'l',
      key: 'lottie',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    } as any);
    expect(resolvePaintIntent(doc, 'l', doc.deltaSetLike!.l).kind).toBe('dom-host');
    doc = addNodeToDocument(doc, 'g', {
      id: 'g',
      key: 'group',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    } as any);
    expect(resolvePaintIntent(doc, 'g', doc.deltaSetLike!.g).kind).toBe('dom-host');
  });

  it('routes empty image generator plates to Kit (wash + glyph)', () => {
    let doc = createEmptyDocument();
    doc = addNodeToDocument(doc, 'gen', {
      id: 'gen',
      key: 'image',
      x: 0,
      y: 0,
      width: 360,
      height: 360,
      attrs: { imageGenerator: true, src: '' },
    } as any);
    expect(resolvePaintIntent(doc, 'gen', doc.deltaSetLike!.gen).kind).toBe('kit');
  });
});
