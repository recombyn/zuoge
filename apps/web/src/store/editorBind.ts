/**
 * Bind editor case mutators to Zustand `set` via immer produce.
 * Call `bindEditorStore` once from store/index.ts during create().
 *
 * `runEditor` lives on globalThis so Vite HMR cannot fork a second binder
 * while React still subscribes to the first Zustand instance (multi-select
 * chrome would then see 1 id while Kit held N).
 */
import { produce } from 'immer';

export type EditorDraftFn = (fn: (draft: any) => void) => void;

type EditorBindSlot = { runEditor: EditorDraftFn };

const g = globalThis as typeof globalThis & {
  __RCB_EDITOR_BIND__?: EditorBindSlot;
};

function editorBindSlot(): EditorBindSlot {
  if (!g.__RCB_EDITOR_BIND__) {
    g.__RCB_EDITOR_BIND__ = {
      runEditor: () => {
        throw new Error('Editor store not bound — import @/store before calling mutators');
      },
    };
  }
  return g.__RCB_EDITOR_BIND__;
}

export function bindEditorStore(run: EditorDraftFn) {
  editorBindSlot().runEditor = run;
}

/**
 * Wrap a (state, action) case reducer as a direct Zustand mutator.
 * - Untyped / inferred-unknown payload → `(payload?: any) => void` so call sites
 *   that pass args stay valid until the reducer is annotated.
 * - `[P] extends [void]` (not bare `P extends void`) so string unions like
 *   `'soft' | 'full'` do not distribute into `never`.
 */
export function bindEditorMutator<S, P = unknown>(
  reducer: (state: S, action: { payload: P }) => void
): unknown extends P
  ? (payload?: any) => void
  : [P] extends [void]
    ? () => void
    : (payload: P) => void {
  return ((payload?: P) => {
    editorBindSlot().runEditor((draft) => {
      reducer(draft, { payload: payload as P });
    });
  }) as unknown extends P
    ? (payload?: any) => void
    : [P] extends [void]
      ? () => void
      : (payload: P) => void;
}

/** Pure apply for unit tests (no Zustand). */
export function applyEditorReducer<S>(
  state: S,
  reducer: (state: S, action: { payload: unknown }) => void,
  payload?: unknown
): S {
  return produce(state, (draft) => {
    reducer(draft as S, { payload });
  });
}
