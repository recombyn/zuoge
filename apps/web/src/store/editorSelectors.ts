/**
 * Editor store selectors — the only React subscription surface for editor slice fields.
 *
 * Use these instead of inline `useSelector(s => s.editor…)`:
 * - Tokens / ids / single fields → narrow hooks below
 * - Stage / bridges that must paint every patch (incl. playhead bake) → `useEditorDocument`
 * - Chrome / docks / toolbars that only need committed scene edits → `useEditorDocumentOnCommit`
 */
import { useMemo } from 'react';
import store, { useSelector, type RootState } from '@/store';
import { EMPTY_ID_LIST } from '@/store/modules/editor';

export function useDocumentPatchToken() {
  return useSelector((s: RootState) => Number(s.editor.documentPatchToken) || 0);
}

export function useSceneReloadToken() {
  return useSelector((s: RootState) => Number(s.editor.sceneReloadToken) || 0);
}

export function useDocumentRevision() {
  return useSelector((s: RootState) => Number(s.editor.documentRevision) || 0);
}

export function useSceneRevision() {
  return useSelector((s: RootState) => Number(s.editor.sceneRevision) || 0);
}

export function useSelectedNodeId() {
  return useSelector((s: RootState) => s.editor.selectedNodeId as string | null);
}

export function useSelectedNodeIds() {
  return useSelector(
    (s: RootState) => (s.editor.selectedNodeIds as string[]) ?? EMPTY_ID_LIST
  );
}

export function useSelectedFrameIds() {
  return useSelector(
    (s: RootState) => (s.editor.selectedFrameIds as string[]) ?? EMPTY_ID_LIST
  );
}

export function useCurrentProjectId() {
  return useSelector((s: RootState) => s.editor.currentId as string | null);
}

export function useActiveFrameId() {
  return useSelector(
    (s: RootState) => (s.editor.document?.activeFrameId as string | null) || null
  );
}

export function useLastPatchedNodeIds() {
  return useSelector(
    (s: RootState) => (s.editor.lastPatchedNodeIds as string[]) ?? EMPTY_ID_LIST
  );
}

export function useLastPatchTransformOnly() {
  return useSelector((s: RootState) => Boolean(s.editor.lastPatchTransformOnly));
}

/** Live scene document — every store write, including playhead bake / skipHistory patches. */
export function useEditorDocument() {
  return useSelector((s: RootState) => s.editor.document);
}

/**
 * Committed scene document — refreshes on documentRevision / sceneRevision.
 * Skips playhead bake and other transient patches that bump documentPatchToken alone.
 * Paste/dupe deliberately delay documentRevision (and skip sceneRevision) so docks
 * do not rebuild during the Kit commit; collab still bumps sceneRevision.
 */
export function useEditorDocumentOnCommit() {
  const documentRevision = useDocumentRevision();
  const sceneRevision = useSceneRevision();
  return useMemo(
    () => store.getState().editor.document,
    [documentRevision, sceneRevision]
  );
}
