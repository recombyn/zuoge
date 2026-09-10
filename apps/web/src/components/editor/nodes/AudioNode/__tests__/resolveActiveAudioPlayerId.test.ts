import { describe, expect, it } from 'vitest';
import { resolveActiveAudioPlayerId } from '../AudioNodeOverlay';
import type { SceneDocument } from '@/components/rcb/sceneNode';

function docWithAudio(ids: string[]): SceneDocument {
  const children = [...ids];
  const deltaSetLike: Record<string, unknown> = {
    ROOT: { id: 'ROOT', key: 'entry', children, attrs: {}, x: 0, y: 0, width: 0, height: 0 },
  };
  for (const id of ids) {
    deltaSetLike[id] = {
      id,
      key: 'audio',
      x: 0,
      y: 0,
      width: 120,
      height: 80,
      attrs: { src: `https://example.com/${id}.mp3` },
      children: [],
    };
  }
  return { deltaSetLike } as SceneDocument;
}

describe('resolveActiveAudioPlayerId', () => {
  it('prefers tool panel, then last selected, then sole board audio', () => {
    const document = docWithAudio(['a0', 'a1']);
    expect(
      resolveActiveAudioPlayerId({
        document,
        selectedNodeIds: [],
        audioToolPanel: { nodeId: 'a1', kind: 'trim' },
      })
    ).toBe('a1');
    expect(
      resolveActiveAudioPlayerId({
        document,
        selectedNodeIds: ['a0', 'a1'],
        audioToolPanel: null,
      })
    ).toBe('a1');
    expect(
      resolveActiveAudioPlayerId({
        document: docWithAudio(['a0']),
        selectedNodeIds: [],
        audioToolPanel: null,
      })
    ).toBe('a0');
    expect(
      resolveActiveAudioPlayerId({
        document,
        selectedNodeIds: [],
        audioToolPanel: null,
      })
    ).toBeNull();
  });

  it('ignores empty generator plates (no src)', () => {
    const document = {
      deltaSetLike: {
        ROOT: {
          id: 'ROOT',
          key: 'entry',
          children: ['g0'],
          attrs: {},
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        },
        g0: {
          id: 'g0',
          key: 'audio',
          x: 0,
          y: 0,
          width: 120,
          height: 80,
          attrs: { audioGenerator: true, src: '' },
          children: [],
        },
      },
    } as SceneDocument;
    expect(
      resolveActiveAudioPlayerId({
        document,
        selectedNodeIds: ['g0'],
        audioToolPanel: null,
      })
    ).toBeNull();
  });

  it('skips uploading SoftGlow audio (no HTML player until finish)', () => {
    const document = {
      deltaSetLike: {
        ROOT: {
          id: 'ROOT',
          key: 'entry',
          children: ['a0'],
          attrs: {},
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        },
        a0: {
          id: 'a0',
          key: 'audio',
          x: 0,
          y: 0,
          width: 120,
          height: 80,
          attrs: {
            src: 'blob:pending',
            processStatus: 'running',
            processKind: 'upload',
          },
          children: [],
        },
      },
    } as SceneDocument;
    expect(
      resolveActiveAudioPlayerId({
        document,
        selectedNodeIds: ['a0'],
        audioToolPanel: null,
      })
    ).toBeNull();
  });
});
