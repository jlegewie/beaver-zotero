# Tests

Unit and integration tests for the Beaver Zotero plugin, using [Vitest](https://vitest.dev/).

## Running tests

```bash
npm test                # unit tests (single run, no Zotero needed)
npm run test:watch      # unit tests — re-run on file changes
npm run test:integration  # integration tests (requires running Zotero)
npx vitest run tests/some-file.test.ts  # run a single file
```

## Directory structure

```
tests/
  setup.ts                  # Global setup — stubs Zotero/Mozilla globals
  mocks/
    mockDBConnection.ts     # Real SQLite (better-sqlite3) mock of Zotero.DBConnection
  *.test.ts                 # Unit test files
  integration/
    helpers/
      fixtures.ts           # Test fixture definitions (attachment refs by library_id + zotero_key)
      zoteroClient.ts       # HTTP client wrapper for Beaver endpoints
      cacheInspector.ts     # Cache state inspection/cleanup via /beaver/test/* endpoints
    *.integration.test.ts   # Integration test files
```

- **`setup.ts`** runs before every test file (configured in `vitest.config.ts` via `setupFiles`). It stubs the Zotero-specific globals (`IOUtils`, `PathUtils`, `Ci`, `Zotero`, `ztoolkit`) that the source code references at import time. All stubs use `vi.fn()` so individual tests can override behavior with `.mockResolvedValue()`, `.mockImplementation()`, etc.
- **`mocks/mockDBConnection.ts`** wraps an in-memory better-sqlite3 database that implements the subset of `Zotero.DBConnection` used by `BeaverDB`: `queryAsync`, `executeTransaction`, `test`, `closeDatabase`. This gives tests real SQLite semantics (constraints, ON CONFLICT, COALESCE, etc.) without a running Zotero instance.

## Writing a new test file

### 1. Create the file

Place it at `tests/<module-name>.test.ts`. Vitest picks up any file matching `tests/**/*.test.ts`.

### 2. Choose your mocking strategy

**Testing database/SQL logic** — use `MockDBConnection` with real SQLite:

```ts
import { MockDBConnection } from './mocks/mockDBConnection';
import { BeaverDB } from '../src/services/database';

let conn: MockDBConnection;
let db: BeaverDB;

beforeEach(async () => {
  conn = new MockDBConnection();
  db = new BeaverDB(conn as any);
  await db.initDatabase('0.99.0');
});

afterEach(async () => {
  await conn.closeDatabase();
});
```

**Testing code that uses filesystem APIs** — override the IOUtils/PathUtils stubs from setup.ts:

```ts
const mockIOUtils = (globalThis as any).IOUtils as {
  exists: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  readUTF8: ReturnType<typeof vi.fn>;
  writeUTF8: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  getChildren: ReturnType<typeof vi.fn>;
  makeDirectory: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks(); // reset all stubs to defaults from setup.ts
});
```

Then in individual tests, configure mock returns:

```ts
mockIOUtils.exists.mockResolvedValue(true);
mockIOUtils.stat.mockResolvedValue({ lastModified: 170000000000, size: 12345 });
mockIOUtils.readUTF8.mockResolvedValue(JSON.stringify(someData));
```

**Combining both** (e.g., testing a service that uses DB + filesystem):

```ts
beforeEach(async () => {
  vi.clearAllMocks();
  conn = new MockDBConnection();
  db = new BeaverDB(conn as any);
  await db.initDatabase('0.99.0');
  cache = new AttachmentFileCache(db);
});
```

### 3. Structure your tests

Follow the existing convention:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('ModuleName', () => {
  // setup in beforeEach/afterEach

  describe('methodName', () => {
    it('does X when Y', async () => {
      // arrange
      // act
      // assert
    });
  });
});
```

### 4. Key patterns to know

**SQLite booleans**: Zotero stores booleans as INTEGER (0/1). `BeaverDB` converts them to/from `boolean` in the application layer. Test both the DB-level values (0/1) and the converted values (true/false).

**`onRow` callback**: Some `BeaverDB` methods use `Zotero.DB.queryAsync` with an `onRow` callback and `getResultByIndex(n)` instead of direct row access. `MockDBConnection` supports this pattern — the callback receives a proxy with `getResultByIndex` mapped to column order from the SELECT.

**Clearing mocks**: Always call `vi.clearAllMocks()` in `beforeEach` to reset all stubs. The stubs in `setup.ts` provide safe defaults (e.g., `IOUtils.exists` returns `false`), so after clearing, each test starts from a known state.

**Private field access**: Use `(instance as any).fieldName` to inspect or set private fields in tests (e.g., `(cache as any).contentCacheDir`).

**Async errors**: When testing that errors are handled gracefully, use `.mockRejectedValue()` and verify the method doesn't throw:

```ts
mockIOUtils.stat.mockRejectedValue(new Error('disk error'));
await expect(cache.someMethod()).resolves.toBeUndefined();
```

## Integration tests

Integration tests exercise the full pipeline against a live Zotero instance: HTTP request -> handler -> PDF extraction -> cache write -> cache read -> response.

### Prerequisites

- Zotero running with the Beaver plugin loaded
- Logged into Beaver (endpoints are only registered when authenticated)
- Test attachments present in the library (see `integration/helpers/fixtures.ts` for the expected items)

### Configuration

Zotero's HTTP server port varies between installations. Set `ZOTERO_HTTP_PORT` to match your instance (default: `23119`):

```bash
ZOTERO_HTTP_PORT=23124 npm run test:integration
```

To find the port, check Zotero's preferences or run:
```js
Zotero.Prefs.get('httpServer.port')
```

### How it works

- Tests use Beaver's local HTTP endpoints (`/beaver/attachment/pages`, etc.) registered in `react/hooks/useHttpEndpoints.ts`.
- Cache inspection and manipulation uses test-only endpoints (`/beaver/test/*`) also registered in `useHttpEndpoints.ts`. These are only available in development/staging builds.
- Tests skip gracefully when Zotero is not available (`beforeAll` pings the server and sets a flag; each `beforeEach` calls `ctx.skip()` if the flag is false).
- `vitest.integration.config.ts` is a separate Vitest config with no `setupFiles` (no Zotero global stubs), a 30-second timeout, and sequential execution.

### Test-only endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /beaver/test/ping` | Verify Zotero + cache + DB are available |
| `POST /beaver/test/cache-metadata` | Get raw cache metadata by `library_id` + `zotero_key` or `item_id` |
| `POST /beaver/test/cache-invalidate` | Invalidate cache (metadata + content) for a specific item |
| `POST /beaver/test/cache-clear-memory` | Clear in-memory LRU cache |
| `POST /beaver/test/cache-delete-content` | Delete content cache file only (keep metadata) |
| `POST /beaver/test/resolve-item` | Resolve `library_id` + `zotero_key` to `item_id` and `item_type` |

### Updating fixtures

Fixtures in `integration/helpers/fixtures.ts` reference real items by `library_id` + `zotero_key`. If your Zotero library differs from the test library, update the keys to match attachments in your library. Each fixture has a `description` field documenting what kind of item it should point to (e.g., "Encrypted PDF", "2-page PDF").

## Conventions

- One test file per logical module/concern (e.g., `database.*.test.ts` for SQL, `attachmentFileCache.metadata.test.ts` for the metadata tier).
- Helper functions (`makeRecord`, `makePage`, etc.) go at the top of the test file, not in shared utilities. Tests should be self-contained.
- Test names describe behavior: `"returns null when content file does not exist"`, not `"test getContentRange"`.
- Close database connections in `afterEach` to avoid leaking file handles.
