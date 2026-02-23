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
// Zotero namespace (minimal)
// ---------------------------------------------------------------------------
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
};

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
