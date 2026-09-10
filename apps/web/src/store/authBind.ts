/**
 * Bind auth case mutators to Zustand.
 *
 * `runAuth` is pinned on globalThis so Vite HMR cannot desync mutators from
 * the React-subscribed Zustand singleton (see store/index.ts).
 */
import { produce } from 'immer';

type AuthDraftFn = (fn: (draft: any) => void) => void;

type AuthBindSlot = { runAuth: AuthDraftFn };

const g = globalThis as typeof globalThis & {
  __RCB_AUTH_BIND__?: AuthBindSlot;
};

function authBindSlot(): AuthBindSlot {
  if (!g.__RCB_AUTH_BIND__) {
    g.__RCB_AUTH_BIND__ = {
      runAuth: () => {
        throw new Error('Auth store not bound — import @/store before calling mutators');
      },
    };
  }
  return g.__RCB_AUTH_BIND__;
}

export function bindAuthStore(run: AuthDraftFn) {
  authBindSlot().runAuth = run;
}

export function bindAuthMutator<S, P = void>(
  reducer: (state: S, action: { payload: P }) => void
): P extends void ? () => void : (payload: P) => void {
  return ((payload?: P) => {
    authBindSlot().runAuth((draft) => {
      reducer(draft, { payload: payload as P });
    });
  }) as P extends void ? () => void : (payload: P) => void;
}

export function applyAuthReducer<S>(
  state: S,
  reducer: (state: S, action: { payload: unknown }) => void,
  payload?: unknown
): S {
  return produce(state, (draft) => {
    reducer(draft as S, { payload });
  });
}
