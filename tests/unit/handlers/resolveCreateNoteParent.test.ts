/**
 * Unit tests for resolveCreateNoteParent (src/services/agentDataProvider/actions/resolveCreateNoteParent.ts).
 *
 * This helper is shared by the WS validator (createNote.ts) and the client
 * apply path (react/utils/createNoteActions.ts), both of which mock it
 * entirely in their own tests — so it needs direct coverage of its own
 * dual-form id parsing and library resolution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveCreateNoteParent } from '../../../src/services/agentDataProvider/actions/resolveCreateNoteParent';

function makeItem(overrides: Partial<Record<string, any>> = {}) {
    return {
        libraryID: 1,
        key: 'PARENT01',
        isRegularItem: () => false,
        isAttachment: () => false,
        isNote: () => false,
        isAnnotation: () => false,
        parentKey: null,
        ...overrides,
    };
}

describe('resolveCreateNoteParent', () => {
    let previousZotero: any;

    beforeEach(() => {
        previousZotero = (globalThis as any).Zotero;
        (globalThis as any).Zotero = {
            Libraries: { userLibraryID: 1 },
            // Group 12345 <-> local library 100. Any other group id is unknown.
            Groups: {
                getLibraryIDFromGroupID: vi.fn((groupId: number) => (groupId === 12345 ? 100 : false)),
            },
            Items: {
                getByLibraryAndKeyAsync: vi.fn(async () => null),
                getAsync: vi.fn(async () => null),
            },
        };
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('returns a standalone (null parentKey) result when no parent_item_id is provided', async () => {
        const result = await resolveCreateNoteParent(null);
        expect(result).toEqual({
            ok: true,
            parentKey: null,
            resolvedLibraryId: null,
            relatedItemKey: null,
            warning: null,
        });
    });

    it('resolves a portable "u-<key>" parent id to a regular-item parentKey', async () => {
        const regular = makeItem({ isRegularItem: () => true });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async (libId: number, key: string) =>
            libId === 1 && key === 'PARENT01' ? regular : null
        );

        const result = await resolveCreateNoteParent('u-PARENT01');

        expect(result).toEqual({
            ok: true,
            parentKey: 'PARENT01',
            resolvedLibraryId: 1,
            relatedItemKey: null,
            warning: null,
        });
    });

    it('reports library_unavailable (not item_not_found) for an unresolvable portable group parent id', async () => {
        const result = await resolveCreateNoteParent('g99999-PARENT01');

        expect(result).toEqual({
            ok: false,
            error: expect.stringContaining('g99999-PARENT01'),
            errorCode: 'library_unavailable',
        });
    });

    it('resolves a legacy numeric parent id', async () => {
        const regular = makeItem({ libraryID: 1, key: 'LEGACY01', isRegularItem: () => true });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async (libId: number, key: string) =>
            libId === 1 && key === 'LEGACY01' ? regular : null
        );

        const result = await resolveCreateNoteParent('1-LEGACY01');

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.parentKey).toBe('LEGACY01');
            expect(result.resolvedLibraryId).toBe(1);
        }
    });

    it('lets a library_ref embedded in the id string win over a disagreeing separate parentLibraryRef parameter', async () => {
        // The id string says "u" (personal, library 1); the separate
        // parentLibraryRef parameter disagrees ("g12345" -> library 100). The
        // id string is what the model actually wrote, so it must win.
        const regular = makeItem({ libraryID: 1, key: 'WINKEY01', isRegularItem: () => true });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async (libId: number, key: string) =>
            libId === 1 && key === 'WINKEY01' ? regular : null
        );

        const result = await resolveCreateNoteParent('u-WINKEY01', 'g12345');

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.resolvedLibraryId).toBe(1);
        }
    });

    it('falls back to the separate parentLibraryRef parameter for a legacy numeric id with no ref of its own', async () => {
        // A legacy numeric id carries no embedded ref, so the separate
        // parameter (when provided) determines the target library.
        const regular = makeItem({ libraryID: 100, key: 'FALLBACK1', isRegularItem: () => true });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async (libId: number, key: string) =>
            libId === 100 && key === 'FALLBACK1' ? regular : null
        );

        const result = await resolveCreateNoteParent('999-FALLBACK1', 'g12345');

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.resolvedLibraryId).toBe(100);
        }
    });

    it('rejects a malformed parent_item_id', async () => {
        const result = await resolveCreateNoteParent('not-valid-###');

        expect(result).toEqual({
            ok: false,
            error: expect.stringContaining('not-valid-###'),
            errorCode: 'invalid_parent_id',
        });
    });
});
