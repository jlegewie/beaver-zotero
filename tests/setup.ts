/**
 * Vitest global setup — stubs Zotero/Mozilla globals that the source code references.
 *
 * These stubs are intentionally minimal: only the shapes that the code under
 * test actually touches need to exist.  Individual test files may override
 * or extend them via vi.spyOn / vi.mocked.
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// IOUtils — Mozilla's async file I/O
// ---------------------------------------------------------------------------
const ioUtils = {
    exists: vi.fn().mockResolvedValue(false),
    stat: vi.fn().mockResolvedValue({ lastModified: 0, size: 0 }),
    read: vi.fn().mockResolvedValue(new Uint8Array()),
    readUTF8: vi.fn().mockResolvedValue(''),
    writeUTF8: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    getChildren: vi.fn().mockResolvedValue([]),
    makeDirectory: vi.fn().mockResolvedValue(undefined),
};
(globalThis as any).IOUtils = ioUtils;

// ---------------------------------------------------------------------------
// PathUtils — Mozilla's path utilities
// ---------------------------------------------------------------------------
const pathUtils = {
    join: vi.fn((...parts: string[]) => parts.join('/')),
    filename: vi.fn((path: string) => {
        const segments = path.split('/');
        return segments[segments.length - 1];
    }),
};
(globalThis as any).PathUtils = pathUtils;

// ---------------------------------------------------------------------------
// Ci — Mozilla component interfaces
// ---------------------------------------------------------------------------
(globalThis as any).Ci = {
    nsIFile: {
        DIRECTORY_TYPE: 1,
    },
};

// ---------------------------------------------------------------------------
// Window lookup
// ---------------------------------------------------------------------------
// Unit tests run in the Node environment by default. Only suites that opt into
// a DOM environment should expose `window`, so avoid eagerly importing jsdom
// here. That import currently fails in this toolchain before any tests load.
// Build a lazy, jsdom-backed window for tests that need real DOM APIs
// (e.g. ProseMirror normalization in the notes suites). We try to load
// jsdom at first access; if it isn't available or fails to initialize,
// the fallback is an empty object and DOM-dependent tests will surface
// their own descriptive errors rather than a stack-overflow recursion.
let fallbackWindow: any = null;
function getTestWindow() {
    if (fallbackWindow) return fallbackWindow;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { JSDOM } = require('jsdom');
        const dom = new JSDOM('<!doctype html><html><body></body></html>');
        fallbackWindow = dom.window;
    } catch {
        fallbackWindow = {};
    }
    return fallbackWindow;
}

// ---------------------------------------------------------------------------
// Zotero namespace (minimal)
// ---------------------------------------------------------------------------

// Stable field/type IDs used by our SQL-level tests. These are what
// Zotero.ItemFields.getID / Zotero.ItemTypes.getID return. Real Zotero
// assigns these dynamically, but stable integers are sufficient for unit
// tests since our seeded schema uses the same IDs.
const TEST_FIELD_IDS: Record<string, number> = {
    title: 110,
    DOI: 26,
    ISBN: 11,
    date: 14,
    publicationTitle: 12,   // a title-mapped field on journalArticle
    bookTitle: 90,          // a title-mapped field on bookSection
    filingDate: 150,        // a date-mapped field for testing precedence
};

const TEST_TYPE_IDS: Record<string, number> = {
    annotation: 1,
    attachment: 3,
    note: 28,
    journalArticle: 4,
    book: 2,
    bookSection: 5,
};

// Minimal DOI cleaner — strips a common "https://doi.org/" prefix and lowercases.
// Zotero's real cleanDOI is more thorough, but this is enough for comparisons.
function testCleanDOI(value: string | null | undefined): string | null {
    if (!value) return null;
    const s = String(value).trim();
    if (!s) return null;
    const match = s.match(/10\.\d{4,}\/\S+/);
    if (!match) return null;
    return match[0].replace(/[.,;:]+$/, '');
}

function testCleanISBN(value: string | null | undefined): string | null {
    if (!value) return null;
    const digits = String(value).replace(/[^0-9Xx]/g, '').toUpperCase();
    if (digits.length !== 10 && digits.length !== 13) return null;
    return digits;
}

function testRemoveDiacritics(s: string): string {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

(globalThis as any).Zotero = {
    File: {
        pathToFile: vi.fn((dir: string) => ({
            clone: () => {
                let currentPath = dir;
                return {
                    get path() { return currentPath; },
                    append(name: string) { currentPath = currentPath + '/' + name; },
                    exists: vi.fn(() => true),
                    create: vi.fn(),
                };
            },
        })),
    },
    Profile: {
        dir: '/mock/profile',
    },
    Prefs: {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn(),
        clear: vi.fn(),
    },
    debug: vi.fn(),
    getMainWindow: vi.fn(() => getTestWindow()),
    Utilities: {
        cleanDOI: vi.fn(testCleanDOI),
        cleanISBN: vi.fn(testCleanISBN),
        removeDiacritics: vi.fn(testRemoveDiacritics),
    },
    Date: {
        strToDate: vi.fn((s: string | undefined | null) => {
            if (!s) return {};
            const match = String(s).match(/(\d{4})/);
            return match ? { year: match[1] } : {};
        }),
    },
    ItemFields: {
        getID: vi.fn((name: string) => TEST_FIELD_IDS[name] ?? 0),
        getTypeFieldsFromBase: vi.fn((baseField: string) => {
            if (baseField === 'title') return [TEST_FIELD_IDS.publicationTitle, TEST_FIELD_IDS.bookTitle];
            if (baseField === 'date') return [TEST_FIELD_IDS.filingDate];
            return [];
        }),
    },
    ItemTypes: {
        getID: vi.fn((name: string) => TEST_TYPE_IDS[name] ?? 0),
    },
    Libraries: {
        getAll: vi.fn(() => [{ libraryID: 1 }]),
    },
};

// Expose the test field/type IDs so tests can reuse them when seeding rows.
(globalThis as any).__TEST_FIELD_IDS = TEST_FIELD_IDS;
(globalThis as any).__TEST_TYPE_IDS = TEST_TYPE_IDS;

// ---------------------------------------------------------------------------
// ztoolkit global (used in hooks.ts, but not in our test targets)
// ---------------------------------------------------------------------------
(globalThis as any).ztoolkit = {
    log: vi.fn(),
};

// ---------------------------------------------------------------------------
// process.env stub (used in dev-only console.log guards)
// ---------------------------------------------------------------------------
if (typeof process === 'undefined') {
    (globalThis as any).process = { env: {} };
}
process.env.NODE_ENV = 'test';
