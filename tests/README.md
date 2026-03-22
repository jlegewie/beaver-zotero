# Tests

Unit, live, and integration tests for the Beaver Zotero plugin, using [Vitest](https://vitest.dev/).

## Running tests

```bash
npm test                                        # unit tests (no Zotero needed)
npm run test:watch                              # unit tests in watch mode
npm run test:live                               # live tests (requires running Zotero)
npm run test:integration                        # integration tests (requires running Zotero)
npm run test:all                                # all three tiers sequentially
npx vitest run tests/unit/notes/editNote.test.ts   # single file
npx vitest run -t "returns empty"               # tests matching name pattern
```

## Three test tiers

| Tier | Dir | File pattern | Zotero required? | Vitest config | Timeout |
|------|-----|-------------|-------------------|---------------|---------|
| **Unit** | `tests/unit/` | `*.test.ts` | No | `vitest.config.ts` | 10 s |
| **Live** | `tests/live/` | `*.live.test.ts` | Yes | `vitest.live.config.ts` | 15 s |
| **Integration** | `tests/integration/` | `*.integration.test.ts` | Yes | `vitest.integration.config.ts` | 30 s |

- **Unit tests** run entirely in Node with mocked Zotero globals. Fast, CI-friendly, and the default for `npm test`.
- **Live tests** hit a single Beaver HTTP endpoint against a running Zotero instance. Use these to verify individual handlers produce correct results with real data. Tests skip gracefully when Zotero is unavailable.
- **Integration tests** exercise multi-step pipelines (e.g., HTTP request -> PDF extraction -> cache write -> cache read). Sequential execution, longer timeout.

## Directory structure

```
tests/
├── setup.ts                        # Global setup — stubs Zotero/Mozilla globals (unit only)
├── mocks/
│   └── mockDBConnection.ts         # In-memory SQLite mock of Zotero.DBConnection
├── helpers/
│   ├── factories.ts                # Mock Zotero object factories (createMockItem, etc.)
│   ├── fixtures.ts                 # Attachment fixture definitions + Zotero port config
│   ├── zoteroHttpClient.ts         # HTTP client for Beaver endpoints
│   ├── zoteroAvailability.ts       # isZoteroAvailable() + skipIfNoZotero()
│   └── cacheInspector.ts           # Cache inspection/cleanup via /beaver/test/* endpoints
├── unit/
│   ├── services/                   # Service layer tests (cache, DB, API)
│   ├── notes/                      # Note editing, HTML processing, read handlers
│   ├── handlers/                   # agentDataProvider handler tests
│   └── utils/                      # Utility function tests
├── live/                           # Single-handler tests against live Zotero
│   └── *.live.test.ts
└── integration/                    # Multi-step pipeline tests against live Zotero
    └── *.integration.test.ts
```

## Writing a new unit test

### 1. Create the file

Place it in the appropriate subdirectory under `tests/unit/`:

| Testing... | Directory |
|-----------|-----------|
| A service (`src/services/*`) | `tests/unit/services/` |
| Note editing / HTML processing | `tests/unit/notes/` |
| An agentDataProvider handler | `tests/unit/handlers/` |
| A utility function | `tests/unit/utils/` |

File name: `<module-name>.test.ts`. Vitest picks up `tests/unit/**/*.test.ts`.

### 2. Choose your mocking strategy

**Testing database/SQL logic** — use `MockDBConnection` with real SQLite:

```ts
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { BeaverDB } from '../../../src/services/database';

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

**Testing code that uses filesystem APIs** — override the IOUtils/PathUtils stubs from `setup.ts`:

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
  vi.clearAllMocks();
});
```

Then configure per-test:

```ts
mockIOUtils.exists.mockResolvedValue(true);
mockIOUtils.stat.mockResolvedValue({ lastModified: 170000000000, size: 12345 });
```

**Using shared factories** for mock Zotero items:

```ts
import { createMockItem, createMockNote, createMockAttachment } from '../../helpers/factories';

const item = createMockItem({ id: 42, fields: { title: 'My Paper' } });
item.getField('title'); // 'My Paper'

const note = createMockNote({ noteHTML: '<div>content</div>' });
const pdf = createMockAttachment({ contentType: 'application/pdf' });
```

**Mocking transitive dependencies**: Code under `src/services/agentDataProvider/` transitively imports Supabase, auth atoms, and other React/store modules. If your test imports from this area, you'll need to mock these:

```ts
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: '123', localUserKey: 'abc' })),
    createCitationHTML: vi.fn(),
}));
vi.mock('../../../react/atoms/profile', () => ({ userIdentifierAtom: {} }));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(), set: vi.fn(), sub: vi.fn() },
}));
```

See `editNote.test.ts` for a comprehensive example.

### 3. Structure your tests

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

### 4. Key patterns

- **SQLite booleans**: DB stores as INTEGER (0/1), `BeaverDB` converts to boolean. Test both levels.
- **`onRow` callback**: `MockDBConnection` supports the `onRow` + `getResultByIndex(n)` pattern.
- **Clearing mocks**: Always `vi.clearAllMocks()` in `beforeEach`. Stubs in `setup.ts` provide safe defaults.
- **Private field access**: `(instance as any).fieldName` for testing internals.
- **Async errors**: `.mockRejectedValue()` + `expect(...).resolves.toBeUndefined()`.

## Writing a new live test

Live tests verify individual handlers against a running Zotero instance.

### 1. Create the file

Place it at `tests/live/<name>.live.test.ts`.

### 2. Use the skip pattern

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';

let available: boolean;

beforeAll(async () => {
  available = await isZoteroAvailable();
  if (!available) {
    console.warn('\n⚠  Zotero not available — live tests will be skipped.\n');
  }
});

describe('handler name', () => {
  beforeEach((ctx) => { skipIfNoZotero(ctx, available); });

  it('returns expected data', async () => {
    const res = await post('/beaver/some-endpoint', { ... });
    expect(res).toMatchObject({ ... });
  });
});
```

### 3. Use shared fixtures and HTTP client

```ts
import { NORMAL_PDF } from '../helpers/fixtures';
import { fetchPages } from '../helpers/zoteroHttpClient';

const res = await fetchPages(NORMAL_PDF, { start_page: 1, end_page: 3 });
```

## Integration tests

Integration tests exercise full pipelines. Same prerequisites as live tests plus specific test attachments.

### Prerequisites

- Zotero running with Beaver plugin loaded and authenticated
- Test attachments present (see `helpers/fixtures.ts`)
- Set `ZOTERO_HTTP_PORT` if not 23119: `ZOTERO_HTTP_PORT=23124 npm run test:integration`

### Test-only endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /beaver/test/ping` | Verify Zotero + cache + DB are available |
| `POST /beaver/test/cache-metadata` | Get raw cache metadata |
| `POST /beaver/test/cache-invalidate` | Invalidate cache for a specific item |
| `POST /beaver/test/cache-clear-memory` | Clear in-memory LRU cache |
| `POST /beaver/test/cache-delete-content` | Delete content file only (keep metadata) |
| `POST /beaver/test/resolve-item` | Resolve library_id + zotero_key to item_id |

## Conventions

- **File placement**: One file per logical module/concern, in the appropriate subdirectory.
- **File naming**: `<module>.test.ts` (unit), `<name>.live.test.ts` (live), `<name>.integration.test.ts` (integration).
- **Test names**: Describe behavior — `"returns null when content file does not exist"`, not `"test getContentRange"`.
- **Shared factories**: Use `helpers/factories.ts` for mock Zotero items. File-local helpers (`makeRecord`, etc.) go at the top of the test file.
- **Cleanup**: Close DB connections in `afterEach`. Call `vi.clearAllMocks()` in `beforeEach`.
- **Fixture updates**: Fixtures in `helpers/fixtures.ts` reference real items by `library_id + zotero_key`. Update keys to match your library.
