# Tests

Unit tests for the Beaver Zotero plugin, using [Vitest](https://vitest.dev/).

## Running tests

```bash
npm test            # single run
npm run test:watch  # re-run on file changes
npx vitest run tests/some-file.test.ts  # run a single file
```

## Directory structure

```
tests/
  setup.ts                  # Global setup — stubs Zotero/Mozilla globals
  mocks/
    mockDBConnection.ts     # Real SQLite (better-sqlite3) mock of Zotero.DBConnection
  *.test.ts                 # Test files
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

## Conventions

- One test file per logical module/concern (e.g., `database.*.test.ts` for SQL, `attachmentFileCache.metadata.test.ts` for the metadata tier).
- Helper functions (`makeRecord`, `makePage`, etc.) go at the top of the test file, not in shared utilities. Tests should be self-contained.
- Test names describe behavior: `"returns null when content file does not exist"`, not `"test getContentRange"`.
- Close database connections in `afterEach` to avoid leaking file handles.
