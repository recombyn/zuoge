# Web frontend data layer

You load server state in `apps/web` through **OpenAPI → OpenAPILink → TanStack Query** (`apiQuery`). HTTP is still FastAPI — the browser does not talk to the database.

## Packages / entry

| Piece | Path |
|-------|------|
| Generated oRPC contract | `packages/contracts` (`npm run gen:contracts`) |
| Client + `apiQuery` | `apps/web/src/service/client.ts` |
| Domain helpers | `apps/web/src/service/*.ts` (projects, wallet, auth, …) |
| Query provider | `apps/web/src/main.tsx` (`QueryClientProvider`) |
| URL state (nuqs) | `NuqsAdapter` in `apps/web/src/router/index.tsx` |

HTTP transport is **ky** via OpenAPILink (not axios). Errors: `getHttpStatus` / `getHttpErrorMessage` in `client.ts` (ORPCError / HTTPError only — no axios-shaped probes).

## Reads: `useQuery(apiQuery…)`

List / Me / Skills / Inspiration / wallet snapshot use TanStack Query against `apiQuery.*`:

```ts
useInfiniteQuery({
  ...apiQuery.projectsListMyProjects.infiniteOptions({
    input: (pageParam: number) => ({ query: { page: pageParam, pageSize: 20 } }),
    initialPageParam: 1,
    getNextPageParam: (last) => /* … */,
  }),
  enabled: authed,
});
```

**Source of truth for lists is Query cache**, not a editor store library mirror. On fetch error, home projects render empty (same idea as Me published: do not keep showing stale cards). Logout / 401 clears project + wallet query caches.

## Wallet & billing UI

| Hook / helper | Role |
|---------------|------|
| `useAuthBillingConfigQuery()` | Public `GET /auth/config` — includes `billingEnabled` |
| `useBillingEnabled()` | **Sole UI switch** — reads `auth/config` only; defaults `true` while loading / on error |
| `useWalletSnapshot()` | Balance + plan from `/wallet/me`; `billingEnabled` from `useBillingEnabled()`, not wallet errors |
| `useWalletMeQuery()` | Authed balance row — may fail independently of billing visibility |

`hideBillingUi = !useBillingEnabled()` in account panels, composer credit chips, generator cards, etc.  
Runtime API switch: `WALLET_BILLING_ENABLED` (default `true`). See [billing.md](./billing.md) · [deployment-modes.md](./deployment-modes.md).

Vite: include `nuqs` and `nuqs/adapters/react-router/v6` in `optimizeDeps.include` so the adapter prebundles (missing prebundle previously 504’d and blanked the app).

## Writes: mutations

Prefer:

```ts
useMutation(apiQuery.walletWalletRedeem.mutationOptions({ onSuccess: … }));
// mutateAsync({ body: { code } })
```

Dual-path calls (like / unlike) use `apiQuery.meMeLike.call` / `meMeUnlike.call` inside a custom `mutationFn`. Multipart upload/import may still use `request` (ky) intentionally.

## URL state (nuqs)

Adapter: `nuqs/adapters/react-router/v6` inside `BrowserRouter`.

| Param | Surface | Default (cleared from URL) |
|-------|---------|----------------------------|
| `nav` | Home sidebar | `home` |
| `q` | Home project search (wired for URL) | `''` |
| `meTab` | Me: published / liked / assets | `published` |
| `category` | Inspiration feed filter | `all` |
| `tab` | `/account` settings | `profile` |

## Home → editor handoff

Prompt / attachments are **not** put in the URL.

1. Home builds `HomeAgentBoot` (`utils/homeAgentBoot.ts`)
2. `useGoEditor` opens `/editor?createNew=1&fromHomeAgent=1` (login may wrap `?from=`)
3. Boot JSON lives in **`sessionStorage`** (`recombyn-home-agent-boot`); new tab: seed that tab’s storage then navigate
4. `EditorPage` / `AgentDock` `peekHomeAgentBoot` → fill composer; then `clearHomeAgentBoot`

## Editor store still owns

Editor **document**, selection, tools, camera-ish UI — local canvas SoT. Do not mirror full project lists into the editor store for home/mine.

## Related

- [canvas-architecture.md](./canvas-architecture.md) — paint / Kit underlayer / demotion / QT cull / Path2D (SoA/WebGL product path retired 2026-09-07)
- [scene-json-spec.md](./scene-json-spec.md) — persisted document JSON
- [billing.md](./billing.md) — `WALLET_BILLING_ENABLED` + `useBillingEnabled`
- [deployment-modes.md](./deployment-modes.md) — self-host / dev / desktop
- [self-hosting.md](./self-hosting.md) — deploy + collab WSS
