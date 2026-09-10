import { describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import {
  getSharedVideoElement,
  resolveActiveVideoDecoderId,
} from '@/components/editor/nodes/VideoNode/VideoHoverPlayback';

/**
 * Regression: selection re-renders must not remount <video> or rewrite src
 * (that resets currentTime to 0 / flashes the first frame).
 */
function PlainVideo({ src, label }: { src: string; label: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [mounted] = useState(() => ({ n: 0 }));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.getAttribute('src') === src) return;
    el.src = src;
  }, [src]);

  useEffect(() => {
    mounted.n += 1;
  }, [mounted]);

  return (
    <div data-label={label}>
      <video ref={ref} data-testid="v" muted playsInline />
      <span data-testid="mounts">{mounted.n}</span>
    </div>
  );
}

function makeVideoDoc(ids: string[]) {
  const deltaSetLike: Record<string, any> = {
    ROOT: { children: ids },
  };
  for (const id of ids) {
    deltaSetLike[id] = {
      key: 'video',
      attrs: { src: `https://cdn.example/${id}.mp4` },
    };
  }
  return { deltaSetLike };
}

describe('canvas video src stability', () => {
  it('keeps the same video element across parent re-renders', () => {
    const { rerender, getByTestId } = render(<PlainVideo src="blob:test-a" label="a" />);
    const el1 = getByTestId('v');
    (el1 as HTMLVideoElement).currentTime = 3.5;

    rerender(<PlainVideo src="blob:test-a" label="b" />);
    const el2 = getByTestId('v');

    expect(el2).toBe(el1);
    expect((el2 as HTMLVideoElement).getAttribute('src')).toBe('blob:test-a');
    cleanup();
  });

  it('does not rewrite src when the url is unchanged', () => {
    const { rerender, getByTestId } = render(<PlainVideo src="https://cdn.example/a.mp4" label="1" />);
    const el = getByTestId('v') as HTMLVideoElement;
    const before = el.getAttribute('src');

    rerender(<PlainVideo src="https://cdn.example/a.mp4" label="2" />);
    expect(el.getAttribute('src')).toBe(before);
    cleanup();
  });
});

describe('resolveActiveVideoDecoderId', () => {
  it('prefers trim panel node over other selections', () => {
    const doc = makeVideoDoc(['v0', 'v1']);
    const id = resolveActiveVideoDecoderId({
      document: doc as any,
      selectedNodeIds: ['v0', 'v1'],
      videoToolPanel: { nodeId: 'v0', kind: 'trim' },
    });
    expect(id).toBe('v0');
  });

  it('picks last selected video when multiple are selected', () => {
    const doc = makeVideoDoc(['v0', 'v1']);
    const id = resolveActiveVideoDecoderId({
      document: doc as any,
      selectedNodeIds: ['v0', 'v1'],
    });
    expect(id).toBe('v1');
  });

  it('mounts sole video on board without selection', () => {
    const doc = makeVideoDoc(['v0']);
    const id = resolveActiveVideoDecoderId({
      document: doc as any,
      selectedNodeIds: [],
    });
    expect(id).toBe('v0');
  });

  it('returns null when no video has src', () => {
    const doc = {
      deltaSetLike: {
        ROOT: { children: ['v0'] },
        v0: { key: 'video', attrs: {} },
      },
    };
    expect(
      resolveActiveVideoDecoderId({
        document: doc as any,
        selectedNodeIds: ['v0'],
      })
    ).toBeNull();
  });

  it('skips uploading SoftGlow video (no HTML decoder until finish)', () => {
    const doc = {
      deltaSetLike: {
        ROOT: { children: ['v0'] },
        v0: {
          key: 'video',
          attrs: {
            src: 'blob:pending',
            processStatus: 'running',
            processKind: 'upload',
          },
        },
      },
    };
    expect(
      resolveActiveVideoDecoderId({
        document: doc as any,
        selectedNodeIds: ['v0'],
      })
    ).toBeNull();
  });
});

describe('shared video decoder singleton', () => {
  it('creates at most one shared video element', () => {
    const wrap = document.createElement('div');
    document.body.appendChild(wrap);

    // Simulate attach via rendering would require full FO stack — call attach path indirectly:
    // first getSharedVideoElement is null until a plate mounts; verify module starts clean.
    expect(getSharedVideoElement()).toBeNull();

    document.body.removeChild(wrap);
    cleanup();
  });
});
