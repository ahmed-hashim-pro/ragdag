# ragdag web

Angular 22 single-page app for ragdag (standalone components, signals, zoneless, no UI kit).

```bash
source ~/.nvm/nvm.sh && nvm use 22.23.3
npm ci
npm start                     # ng serve on :4200, proxies /api → http://127.0.0.1:8000 (proxy.conf.json)
npm run build                 # production build → dist/web/browser (serve with SPA fallback to index.html)
npm test -- --watch=false     # unit tests (Vitest + jsdom, headless)
```

Layout of `src/app`:

- `api/` — typed models mirroring `docs/openapi.json`, one service per API area, the fetch-based SSE client for `/ask`.
- `core/` — auth (in-memory access token, refresh cookie, interceptor, guards), workspace context/roles, toasts, theme, progress bar.
- `shared/` — markdown renderer (escapes everything, emits a fixed tag set), SSE parser, dialogs/drawers, badges, formatting.
- `features/` — lazy-loaded pages: auth (login / invite), shell, ask, collections (+ tabs), pipelines (DAG graph), settings, account.
