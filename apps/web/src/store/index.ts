/**
 * App store — Zustand native writes (no action/reducer bus).
 *
 * Write style:
 * - Mutators: `setDocument(doc)` from `@/store/modules/editor` (bound here).
 * - React subscriptions via `editorSelectors.ts` / `useSelector`.
 * - Playhead/playing: `animationTransport` + events.
 *
 * The Zustand instance is pinned on `globalThis` so Vite HMR cannot fork a
 * second store while React still subscribes to the first — that desync made
 * Kit multi-select (N ids) paint a single-node toolbar (1 id) with no boolean.
 */
import { create } from 'zustand';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { produce } from 'immer';
import { bindAuthStore } from '@/store/authBind';
import { bindEditorStore } from '@/store/editorBind';
import { authInitialState, type AuthState } from './modules/auth';
import { editorInitialState, type EditorState } from './modules/editor';

export type RootState = {
  auth: AuthState;
  editor: EditorState;
};

type AppStoreState = RootState;

type AppStore = ReturnType<typeof create<AppStoreState>>;

const g = globalThis as typeof globalThis & {
  __RCB_USE_APP_STORE__?: AppStore;
};

function createAppStore(): AppStore {
  return create<AppStoreState>(() => ({
    auth: authInitialState,
    editor: editorInitialState,
  }));
}

export const useAppStore: AppStore =
  g.__RCB_USE_APP_STORE__ ?? (g.__RCB_USE_APP_STORE__ = createAppStore());

// Always (re)bind mutators to the singleton — HMR of this module or editorBind
// must not leave runEditor pointing at a discarded store instance.
bindEditorStore((fn) => {
  useAppStore.setState((prev) => ({
    ...prev,
    editor: produce(prev.editor, fn),
  }));
});

bindAuthStore((fn) => {
  useAppStore.setState((prev) => ({
    ...prev,
    auth: produce(prev.auth, fn),
  }));
});

/** Vanilla store API (non-React). */
export const store = {
  getState: (): RootState => {
    const s = useAppStore.getState();
    return { auth: s.auth, editor: s.editor };
  },
  setState: useAppStore.setState,
  subscribe: (listener: () => void) => useAppStore.subscribe(() => listener()),
};

export default store;

export type { EditorState } from './modules/editor';
export type { AuthState } from './modules/auth';
export type { PayloadAction } from './payload';

/** Vanilla store handle for non-React callers (`getState` / `subscribe`). */
export function useStore() {
  return store;
}

/** Subscribe to a slice of `{ auth, editor }`. */
export function useSelector<T>(
  selector: (state: RootState) => T,
  equalityFn?: (a: T, b: T) => boolean
): T {
  return useStoreWithEqualityFn(
    useAppStore,
    (s) => selector({ auth: s.auth, editor: s.editor }),
    equalityFn
  );
}
