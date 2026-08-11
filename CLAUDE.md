# Beaver (Zotero plugin)

Beaver is an academic research assistant shipped as a Zotero plugin. The plugin is
TypeScript; Zotero itself is JavaScript, so drop type annotations when adapting code
from this repo to run inside Zotero.

## Commands

| Task | Command |
|------|---------|
| Dev build (also packs `beaver.xpi`, runs `tsc --noEmit` + `typecheck:core`) | `npm run build:dev 2>&1` |
| Production build | `npm run build` |
| Hot-reload dev loop | `npm start` (`zotero-plugin serve` + webpack watch) |
| Typecheck | `npx tsc --noEmit` |
| Core-package gate | `npm run typecheck:core` |
| Lint / format | `npm run lint:check` · `npm run lint:fix` |
| Unit tests (no Zotero) | `npm test` · `npm run test:watch` |
| Live / integration tests (running Zotero) | `npm run test:live` · `npm run test:integration` |
| Single test file / name | `npx vitest run tests/unit/<path>.test.ts` · `npx vitest run -t "returns empty"` |

Notes:

- `tsconfig.json` covers `src/`, `react/`, `typings/` only — **`tsc --noEmit` never
  typechecks `tests/`**. A broken test contract passes typecheck; run the suites.
- **Never create commits** unless explicitly asked.

### Build vs. watch — do not mix them

**Never run `npm run build:dev` while `npm start` is running.** `build:dev` calls
`zotero-plugin build`, which rebuilds `.scaffold/build` in *build* mode and omits
`bootstrap.js`. The serve process manages that same directory and templates its own
`bootstrap.js` into it, so a manual build removes it and the next reload fails with
`Plugin ... is missing bootstrap method 'startup'` — the React panes never mount. With
`npm start` up, rely on its hot-reload. To recover a clobbered directory without
restarting the watcher, `touch addon/bootstrap.js` so the serve re-templates it.

`npm start` hot-reloads the *whole* plugin on every save: it re-registers
`chrome://beaver/...`, re-runs `onMainWindowLoad()`, and re-mounts the React roots.
Consequences:

- **Reload churn invalidates `chrome://` workers mid-flight.** The MuPDF worker is
  `new Worker("chrome://beaver/content/scripts/mupdf-worker.js")`; a reload during an
  extraction invalidates that URL, so the worker fails to *load* (empty `onerror`) and
  respawns into the still-reloading URL — a respawn storm. Check
  `/beaver/test/worker-stats` (`hasWorker:false`, climbing `spawnCount`/`retryCount`) and
  recover with a clean build + reload. This is not the poison-PDF path the worker hardens
  against.
- **Don't edit source while a live/integration run is extracting.**
- Hot reload only refreshes the bundles and UI, not global state that survives a window
  reload (DB, Supabase, services). Startup-only wiring needs a full plugin reload.

## Source layout: three roots, two bundles

| Root | Bundled by | Entry → output |
|------|-----------|----------------|
| `src/` | esbuild | `src/index.ts` → `content/scripts/beaver.js` — lifecycle, hooks, database, services |
| `react/` | webpack | `react/index.tsx` → `content/reactBundle.js` — React UI, Jotai atoms, Supabase client, auth |
| `packages/agent-core/` | both (compiled from source) | consumed as `@beaver/agent-core/<subpath>` |

**The two bundles cannot import from each other.** The webpack bundle is loaded via a
`<script>` tag into the window; cross-bundle communication goes through `__beaver*`
properties on `Window`/`Zotero` (e.g. `__beaverEventBus`, `__beaverJotaiStore`).

### `addon` global vs `Zotero.Beaver`

The `addon` singleton (`src/addon.ts`) holds plugin-wide state (`addon.db`,
`addon.citationService`, …) and is aliased as `Zotero.Beaver`. **The bare `addon` global
exists only in the esbuild bundle.** Many `src/` files are transitively imported by the
webpack bundle (e.g. `src/services/agentDataProvider/*` via `react/atoms/agentRunAtoms.ts`)
and will throw `ReferenceError: addon is not defined` there.

**Rule:** in any `src/` file that might be imported by the webpack bundle, use
`Zotero.Beaver?.xxx`. When in doubt, use `Zotero.Beaver` — it works in both bundles. Types
live in `typings/global.d.ts`.

### Shared code across bundles

Before moving or reusing a helper, check its full import chain. An esbuild-safe module must
not value-import `react/*`, the Jotai store/atoms, popup utilities, `supabaseClient`, or
anything that pulls them in transitively.

Organize shared code by domain, not by caller (document extraction under
`src/services/documentExtraction/`, not under `agentDataProvider/` or a generic utils file).
Keep `src/utils/*` small and React-free unless explicitly UI-only. When a shared operation
needs UI behavior, keep the core helper React-free and inject the UI behavior from the
webpack-side caller via a callback or wrapper.

## `packages/agent-core` — the client-agnostic core

The wire protocol and its type closure (`protocol/`, `transport/`, `run-state/`, `types/`,
`agents/`, `citations/`, `identity/`, `platform/`, `extract/`) live here and are imported as
`@beaver/agent-core/<subpath>` from `src/`, `react/`, and `tests/`.

- **Import by package specifier, never by relative path**, and never re-add a copy of a
  moved module under `src/`/`react/`. Resolution is wired for tsc (root `paths`), webpack,
  esbuild, tsx, and every vitest config — new tooling must be added to all of them.
- **It must typecheck with no Zotero present**: no `Zotero` global, no `_ZoteroTypes`, no
  `process`, no React (`jotai/vanilla` only), no `react/atoms|store|utils|hooks|components`,
  no `agentDataProvider`, no `src/utils/prefs`, no `react/host/zotero/*`. Host globals are
  limited to `packages/agent-core/src/globals.d.ts`; needing a new one is a design question.
  Zotero behavior reaches the core through registered seams.
- **`npm run typecheck:core` is the gate** (CI and every `build*` script). It typechecks
  standalone and runs `verify-program.mjs`, which fails if the closure drifts from the
  tsconfig `files` list, reaches outside the package, or leaves an orphan file. **Adding a
  file means adding it to `files` in `packages/agent-core/tsconfig.json`**, reachable from
  `agentProtocol.ts`.
- `packages/agent-core/package.json` must keep `"type": "module"` — without it, Node-native
  loaders treat the package as CommonJS.
- New protocol / run-state / transport code belongs in this package, not in `src/`/`react/`.
- MuPDF worker code (`src/beaver-extract/worker/**`) may import **only**
  `@beaver/agent-core/extract/*`, and may not otherwise leave `src/beaver-extract`
  (lint-enforced).

## Client host seam and the shared render layer

Client-specific behavior is injected, not imported. The registry lives in the shared package,
`@beaver/agent-ui/host` (`ClientHost` with optional slices: `navigation`, `itemData`,
`documentExport`, `noteWriter`, `config`, `components`, `documentActions`, `dialogs`) — a shared
component must be able to import its seam without reaching into a client's source tree. The
Zotero implementations stay in `react/host/zotero/*` and are registered once at bundle init by
`registerZoteroHost()` (called from `react/index.tsx`). Absent slices must degrade gracefully;
Zotero has no `documentActions` (that slice is for document-hosted clients).

Shared render components reach client-specific behavior only through
`getHost().<slice>?.<method>(...)`. Rules that are load-bearing:

- **Lint guard** — `eslint.config.mjs` scopes a rule to the shared render files (citations,
  `toolResultViews/**`, the agent-run dispatchers, …) banning the `Zotero` global,
  `react/host/zotero/*` imports, and `src/utils/prefs` imports. When a file becomes clean,
  add it to that `files` list; don't add one before it is clean or CI breaks.
- **Store / reactivity** — render-time host methods must receive store-derived state as a
  parameter (the hook subscribes via `useAtomValue` and passes it in). They must **not** read
  the module-global `store`; that breaks the isolated store used by note export /
  `renderToHTML`. Interaction-time methods (click handlers) may read the global store.
- **Data boundary** — everything needed to render must arrive self-contained in
  message/run history or hydrated metadata, adapted at the boundary (`react/atoms/threads.ts`,
  `agentRunAtoms`), never fetched live from Zotero at render time.
- Client-specific *components* are also provided by the host (`components` slice) rather than
  imported by shared code, so the dependency arrow stays shared → host interface.

Applying it to a new surface: make the render data self-contained at the boundary → extract a
`use<X>ViewModel` hook that derives from client-agnostic atoms only → route client-specific
calls through `getHost()` (extend an existing slice before adding one) → implement the Zotero
side under `react/host/zotero/<slice>.ts` (wrap existing helpers, don't rewrite) and wire it
into `registerZoteroHost()` → add the folder to the lint guard.

## Windows and React mounting points

Beaver runs in the **main Zotero window** and in a **separate Beaver window**
(`addon/content/beaverWindow.xhtml`), which reuses the main window's React instance rather
than loading its own bundle.

**Never use bare `window`** in plugin code. Use `Zotero.getMainWindow()`, the `win` parameter
threaded through `BeaverUIFactory` methods and hooks, or `ownerDocument.defaultView`.

| Mount point | Location | Component |
|-------------|----------|-----------|
| `#beaver-react-root-library` | `#zotero-item-pane` (main window) | `<LibrarySidebar />` |
| `#beaver-react-root-reader` | `#zotero-context-pane` (main window) | `<ReaderSidebar />` |
| `#beaver-pane-window` | separate Beaver window | `<WindowSidebar />` (`isWindow={true}`) |

A hidden `#beaver-global-initializer-root` mounts `<GlobalContextInitializer />` for global
hooks (auth, tab tracking, …).

- **One Jotai store** is shared across all mount points (`Zotero.__beaverJotaiStore`, see
  `react/store.ts`). **Scroll state is separate**: `useAutoScroll()` picks sidebar vs. window
  atoms from the `isWindow` prop — pass it correctly.
- Events always dispatch to the main window's event bus (`react/events/eventManager.ts`); the
  separate window listens via the shared store.

### Window lifecycle (close window ≠ quit app)

On macOS, closing the last window does not quit Zotero. `onMainWindowUnload()`
(`src/hooks.ts`) handles three cases: another window remains, the last window closes while the
app runs (window-specific cleanup only — DB, Supabase, services stay alive), and the app
quitting (full global cleanup behind the `isAppQuitting || isAppShuttingDown` guard).

**`onMainWindowLoad()` must fully re-bootstrap the UI from scratch** — never assume
`onStartup()` just ran.

During cleanup, unmount React roots **before** removing DOM (stale `Zotero.Notifier` observers
otherwise cause SIGSEGV), and restore `Zotero.Reader.onChangeSidebarWidth` in
`UIManager.cleanup()`.

## Zotero API conventions

### Data is lazy-loaded

`Zotero.Items.getAsync()` loads only `primaryData` — not `itemData` (field values). Calling
`item.getField()` without loading throws "Item data not loaded".

```typescript
const item = await Zotero.Items.getAsync(itemID);
await item.loadDataType("itemData");
const title = item.getField("title");

// Multiple items — batch it:
await Zotero.Items.loadDataTypes(items, ["itemData", "creators", "tags"]);
```

Common types: `itemData` (fields), `creators`, `tags`, `collections`, `childItems`.

### `Zotero.DB.queryAsync` — always use the `onRow` callback

The returned rows are a Proxy that yields empty/undefined properties outside the main window
scope (WebSocket handlers, background tasks). Collect results yourself, by column index:

```typescript
const results: { itemID: number; value: string }[] = [];
await Zotero.DB.queryAsync(sql, params, {
    onRow: (row: any) => {
        results.push({ itemID: row.getResultByIndex(0), value: row.getResultByIndex(1) });
    },
});
```

This applies to every query, including simple `COUNT`s. See `src/utils/sync.ts`.

## Library exclusions (enforce in every data / write / index path)

Users can exclude Zotero libraries in Beaver Preferences. Exclusion is an access-control
boundary: Beaver must not index, search, read new data from, attach as model context, or
modify an excluded library. Exclusions live on `profile.excluded_libraries`.

Exclusion is **not** a UI restriction. Threads that already reference an excluded library keep
working — history renders, and the user may click a reference to reveal or open the item.
Render paths, view models, preview components, and reveal/open click handlers may resolve
library references and perform local lookups to enrich persisted history, and must **not** be
gated with `isLibrarySearchable` / `checkLibraryExcluded`.

Single source of truth: `searchableLibraryIdsAtom` (`react/atoms/profile.ts`). Helpers in
`src/services/agentDataProvider/utils.ts`: `checkLibraryExcluded(libraryId)` (returns
`{ message }` or `null`; also `null` for a nonexistent library so the caller's own not-found
path handles bad refs), `isLibrarySearchable`, `getSearchableLibraryIds`,
`validateLibraryAccess`, `excludedLibraryMessage`.

Gate **before** the item lookup / read / mutation:

- **Read & data handlers** (`agentDataProvider/handle*.ts`): reject right after format
  validation — `const ex = checkLibraryExcluded(ref.library_id); if (ex) return errorResponse(ex.message, 'library_excluded');`
- **Agent actions** (`agentDataProvider/actions/*.ts`): check in **both** `validate*` and
  `execute*` (TOCTOU) before any `saveTx` / mutation.
- **Search / list / browse**: scope to `getSearchableLibraryIds()` / `validateLibraryAccess(...)`,
  never `Zotero.Libraries.getAll()`.
- **Context funnels** that stage items for a run (selection, prompt variables, reader
  auto-attach): filter by `searchableLibraryIds` directly — do not rely on cached item
  validation, since an un-validated item reads as allowed.

The backend passes `library_excluded` / `library_not_searchable` straight to the model; keep
that pass-through.

## Tests

Three tiers — **`tests/README.md` has the details, templates, and shared-state caveats.**

| Tier | Dir | Pattern | Zotero? | Config |
|------|-----|---------|---------|--------|
| Unit | `tests/unit/` | `*.test.ts` | No | `vitest.config.ts` |
| Live | `tests/live/` | `*.live.test.ts` | Yes | `vitest.live.config.ts` |
| Integration | `tests/integration/` | `*.integration.test.ts` | Yes | `vitest.integration.config.ts` |

- Live and integration tests hit Beaver's dev HTTP endpoints on a running, **logged-in**
  Zotero, and share one instance.
- **"N skipped, exit 0" is not a pass.** Live suites skip themselves when the instance is
  unreachable. Read the `Tests` line. Setting `ZOTERO_HTTP_PORT` pins the run to that instance
  and turns an unreachable/logged-out instance into a hard failure.
- Vitest does not load `.env`; pass `ZOTERO_HTTP_PORT` explicitly.
- **Don't pipe a live run through `tail`/`head`** — the pipe buffers the whole run (~5 min).
  Redirect to a file and read that.
- Unit-test essentials: `MockDBConnection` (better-sqlite3) for real SQLite semantics,
  `tests/helpers/factories.ts` for items, `vi.clearAllMocks()` in `beforeEach`, and transitive
  mocks (`supabaseClient`, `zoteroUtils`, `react/atoms/profile`, `react/store`) for anything
  importing `agentDataProvider`. Behavior-driven test names.

## Dev-only HTTP endpoints

The plugin registers dev-only endpoints under `/beaver/test/*` (see
`react/hooks/useHttpEndpoints.ts`) for inspecting extraction, cache, and run state without
driving the UI:

```bash
curl -sS -X POST http://127.0.0.1:<port>/beaver/test/<name> \
  -H 'Content-Type: application/json' -d '{}'
```

They are registered from the React bundle and gated on authentication, so **they exist only
once Beaver is logged in on that instance**. `/connector/ping` answering while
`/beaver/test/ping` 404s means "logged out", not "wrong port". Zotero's HTTP port is not
necessarily the default `23119` — read it at runtime (`Zotero.Server.port`) or from the
worktree metadata below.

## Working in a git worktree

Worktrees let an isolated Zotero run beside the main dev instance. **Don't create one on your
own initiative** — work in the current checkout unless asked. They are **reload-driven** by
default (edit → `reload` → probe); only start a watcher when doing hot-reload UI iteration,
since saves under a watcher can interrupt in-flight HTTP/RDP/worker work.

### Who creates the worktree?

Agents often do **not** create it themselves:

| How you got here | What to do |
|------------------|------------|
| Tooling already opened a worktree (e.g. `.claude/worktrees/…`) | You are already in it. **Do not** run `git worktree add` — the checkout exists but is usually bare (no `node_modules`, no isolated Zotero). Bootstrap it. |
| Nothing exists yet and the user asked for a worktree | Create + bootstrap with `setup-worktree.sh`. |

If `$PWD` is already a linked worktree and not the main repo, treat it as the target.

```bash
scripts/worktree/worktree-zotero.sh status   # profile/ports, and whether Zotero is running
test -f .worktree-meta.json && cat .worktree-meta.json
```

### 1. Bootstrap (only if needed)

```bash
# Existing worktree path that needs an isolated Zotero:
WORKTREE_DIR=/path/to/worktree scripts/worktree/setup-worktree.sh <branchname>

# No worktree yet — creates ../beaver-zotero-<branch> + isolated Zotero:
scripts/worktree/setup-worktree.sh <branchname>

# Existing worktree, no Zotero needed (unit tests / lint / typecheck / build):
scripts/worktree/setup-worktree.sh --lite /path/to/worktree
```

- New branches are created from **current HEAD**, not `main`. To base on `main`, run
  `git branch <name> main` first.
- Full setup clones the dev profile/data dir, allocates unique HTTP + RDP ports, forces sync
  **off** in the clone, and builds the React bundle if the worktree lacks one. Re-running is
  safe and **keeps the ports the worktree already has**: a profile/data dir kept from an
  earlier run is never touched (no lock or recovery-marker cleanup, no checkpointing), and
  `--start` won't launch a second Zotero against a profile that already has one.
- A fresh worktree must have `addon/content/reactBundle.js` before `npm start`; the serve
  installs the plugin long before webpack's first build finishes and does not re-copy the
  bundle afterwards. Setup builds it; a hand-bootstrapped worktree needs
  `npm run build-react:dev` first.
- Fixture directories and the git-ignored agent instruction files (`CLAUDE.local.md`,
  `AGENTS.md`) are **symlinked, not copied**, so a worktree always reads the main
  checkout's version — and edits to them mutate that version. `.env` is a real copy,
  since full setup rewrites it with this worktree's profile path and ports.
- The instruction-file links are also created by `scripts/worktree/hooks/post-checkout`,
  which the bootstrap installs into the shared hook directory. It fires on every
  `git worktree add`, so worktrees created by other tooling get them without running any
  setup. It never replaces an existing file and always exits 0. If a worktree has no
  `CLAUDE.local.md`, the hook is not installed on this machine — run the `--lite`
  bootstrap.

### 2. Run and update that worktree's Zotero

```bash
cd /path/to/worktree
scripts/worktree/worktree-zotero.sh open      # focus if running, else launch (no watcher)
scripts/worktree/worktree-zotero.sh reload    # build:dev + install xpi + reload via RDP
scripts/worktree/worktree-zotero.sh watch     # optional npm start; don't build:dev/reload while up
scripts/worktree/worktree-zotero.sh status | stop | list
scripts/worktree/worktree-zotero.sh fix-db    # window stuck on "Checking database integrity…"
```

After `reload`, wait until the instance answers:

```bash
HTTP=$(python3 -c "import json; print(json.load(open('.worktree-meta.json'))['httpPort'])")
curl -sS -X POST "http://127.0.0.1:$HTTP/beaver/test/ping" -H 'Content-Type: application/json' -d '{}'
```

### 3. Ports and talking to the instance

**`.worktree-meta.json` is the source of truth** for `httpPort` / `rdpPort` — parse it, never
guess or re-derive. A port must also be free on the machine: Zotero does not fall back, it
logs an error and runs with **no HTTP server at all**, which looks like a broken plugin.

| Goal | How |
|------|-----|
| Live / integration tests | `ZOTERO_HTTP_PORT=<http> npm run test:live` (from the worktree) |
| Dev endpoints | `POST http://127.0.0.1:<http>/beaver/test/...` |
| One-off JS on that instance | `node scripts/worktree/zotero-rdp-exec.mjs <rdpPort> zotero_execute_js '{"code":"..."}'` |

Multiple Zotero instances coexist because `zotero-plugin.config.ts` sets
`server: { startArgs: ["-no-remote"] }`. Keep that.

`.worktree-meta.json`, `.mcp.json`, and the worktree log files are git-excluded and never
reach other worktrees.

### Cloned databases

Zotero runs its databases in WAL mode and truncates the WAL on a clean shutdown, so a non-empty
WAL at startup means "unclean" and triggers a full integrity check before the UI is usable.
Copying a *running* Zotero's data dir always produces that state.
`scripts/worktree/lib/zotero-clone.sh` checkpoints each cloned `*.sqlite` at clone time, so
failures surface during setup (`(dropped) <db>` = mismatched WAL discarded, clone intact but
possibly missing the newest changes; `(FAILED) zotero.sqlite` = re-run after quitting the
source Zotero). `fix-db` applies the same treatment to an already-created clone.

## Code style

- **Docstrings**: concise but useful; document what a function does, not how it evolved.
- **Comments**: explain the current implementation to a new contributor, including warnings
  that prevent regressions. Do **not** over-explain, reference test cases or fixture ids,
  compare against previous versions of the code ("pre-refactor, this used to…"), or mention
  internal planning documents. This repository is public — comments must not leak internal or
  development-only details.

## Deprecated — do not build on

These paths are inert and should not be extended or used as a pattern:

- `isDatabaseSyncSupportedAtom` and everything gated behind it: database sync
  (`useZoteroSync.ts`, `sync.ts`), file upload (`FileUploader.ts`), file status reporting
  (`FileStatusDisplay.tsx`).
- `profile.plan` and derived atoms such as `PlanFeatures`. (`profile.credit_plan` is current.)
