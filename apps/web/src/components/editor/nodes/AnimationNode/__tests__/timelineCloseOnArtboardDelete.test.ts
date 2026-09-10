/**
 * Deleting the 动画工作台 must fully close Keyframes (panel + module focus).
 * Kit flush removes hosts before artboards — orphaned panel must still close.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  editorReducers,
  reduceEditor,
} from '@/store/modules/editor';
import { createEmptyDocument } from '@/components/rcb/scene/document/sceneDocument';
import {
  getAnimationWorkbenchTimelineFocus,
  setAnimationWorkbenchTimelineFocus,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { findFrameAnimationMediaId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';

afterEach(() => {
  setAnimationWorkbenchTimelineFocus(null);
});

function seed() {
  let state = reduceEditor(undefined, () => {});
  state = reduceEditor(state, editorReducers.createTemplate, {
    name: 'timeline-close-delete',
    document: createEmptyDocument({ emptyWorld: true }),
    emptyWorld: true,
    source: 'scratch',
  });
  return state;
}

describe('timeline close on artboard delete', () => {
  it('removeArtboardFrames closes timeline and clears focus', () => {
    let state = seed();
    state = reduceEditor(state, editorReducers.spawnAnimationBoard, {
      x: 0,
      y: 0,
      width: 400,
      height: 400,
    });
    const frameId = String(state.selectedFrameIds[0] || '');
    state = reduceEditor(state, editorReducers.ensureAnimationFrameMedia, {
      frameId,
      skipHistory: true,
    });
    const hostId = findFrameAnimationMediaId(state.document, frameId)!;
    state = reduceEditor(state, editorReducers.openLottieTimelinePanel, {
      nodeId: hostId,
    });
    expect(state.lottieTimelinePanel?.nodeId).toBe(hostId);
    expect(getAnimationWorkbenchTimelineFocus()).toBe(frameId);

    state = reduceEditor(state, editorReducers.removeArtboardFrames, [frameId]);
    expect(state.lottieTimelinePanel).toBeNull();
    expect(getAnimationWorkbenchTimelineFocus()).toBeNull();
    expect(state.selectedFrameIds).toEqual([]);
  });

  it('closes timeline when host was already removed (Kit flush order)', () => {
    let state = seed();
    state = reduceEditor(state, editorReducers.spawnAnimationBoard, {
      x: 0,
      y: 0,
      width: 400,
      height: 400,
    });
    const frameId = String(state.selectedFrameIds[0] || '');
    state = reduceEditor(state, editorReducers.ensureAnimationFrameMedia, {
      frameId,
      skipHistory: true,
    });
    const hostId = findFrameAnimationMediaId(state.document, frameId)!;
    state = reduceEditor(state, editorReducers.openLottieTimelinePanel, {
      nodeId: hostId,
    });
    expect(getAnimationWorkbenchTimelineFocus()).toBe(frameId);

    // Simulate Kit: mapped/DomHost nodes first, then artboard.
    state = reduceEditor(state, editorReducers.removeDocumentNodes, {
      nodeIds: [hostId],
    });
    expect(state.lottieTimelinePanel).toBeNull();
    expect(getAnimationWorkbenchTimelineFocus()).toBeNull();

    // Re-open focus as if incomplete close left module focus (legacy path).
    state = {
      ...state,
      lottieTimelinePanel: { nodeId: hostId },
    };
    setAnimationWorkbenchTimelineFocus(frameId);

    state = reduceEditor(state, editorReducers.removeArtboardFrames, [frameId]);
    expect(state.lottieTimelinePanel).toBeNull();
    expect(getAnimationWorkbenchTimelineFocus()).toBeNull();
    expect(state.document?.frames?.some((f) => String(f?.id) === frameId)).toBe(
      false
    );
  });
});
