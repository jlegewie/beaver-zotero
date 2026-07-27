import { afterEach, describe, expect, it } from 'vitest';

import { isLibraryInScope, isLibraryScopeKnown } from '../../../src/services/libraryScope';

function setMirror(mirror: Record<string, unknown> | undefined) {
    (globalThis as any).Zotero.Beaver = mirror;
}

afterEach(() => {
    setMirror(undefined);
});

describe('libraryScope', () => {
    it('reports the scope as unknown until the mirror is published', () => {
        setMirror(undefined);
        expect(isLibraryScopeKnown()).toBe(false);
        expect(isLibraryInScope(1)).toBe(false);

        setMirror({});
        expect(isLibraryScopeKnown()).toBe(false);
        expect(isLibraryInScope(1)).toBe(false);
    });

    it('denies every library when the flag is set without ids', () => {
        setMirror({ libraryScopeInitialized: true });

        expect(isLibraryScopeKnown()).toBe(false);
        expect(isLibraryInScope(1)).toBe(false);
    });

    it('denies every library when ids are present but not yet authoritative', () => {
        setMirror({ libraryScopeInitialized: false, searchableLibraryIds: [1] });

        expect(isLibraryScopeKnown()).toBe(false);
        expect(isLibraryInScope(1)).toBe(false);
    });

    it('allows only the mirrored libraries once the scope is known', () => {
        setMirror({ libraryScopeInitialized: true, searchableLibraryIds: [1, 5] });

        expect(isLibraryScopeKnown()).toBe(true);
        expect(isLibraryInScope(1)).toBe(true);
        expect(isLibraryInScope(5)).toBe(true);
        expect(isLibraryInScope(2)).toBe(false);
    });

    it('treats an empty searchable set as a known scope that allows nothing', () => {
        setMirror({ libraryScopeInitialized: true, searchableLibraryIds: [] });

        expect(isLibraryScopeKnown()).toBe(true);
        expect(isLibraryInScope(1)).toBe(false);
    });
});
