import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeMessageFiltersForSearchableLibraries } from '../../../react/utils/messageFilters';
import type { MessageFiltersState } from '../../../react/atoms/messageComposition';

function filters(overrides: Partial<MessageFiltersState> = {}): MessageFiltersState {
    return {
        libraryIds: [],
        collectionIds: [],
        tagSelections: [],
        ...overrides,
    };
}

describe('sanitizeMessageFiltersForSearchableLibraries', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('removes library, collection, and tag filters outside the searchable scope', () => {
        vi.stubGlobal('Zotero', {
            Collections: {
                get: vi.fn((id: number) => {
                    if (id === 10) return { id, libraryID: 1 };
                    if (id === 20) return { id, libraryID: 2 };
                    return null;
                }),
            },
        });

        const result = sanitizeMessageFiltersForSearchableLibraries(
            filters({
                libraryIds: [1, 2],
                collectionIds: [10, 20, 30],
                tagSelections: [
                    { id: 100, tag: 'kept', libraryId: 1, type: 0, color: '' },
                    { id: 200, tag: 'removed', libraryId: 2, type: 0, color: '' },
                ],
            }),
            [1],
        );

        expect(result.changed).toBe(true);
        expect(result.state).toEqual({
            libraryIds: [1],
            collectionIds: [10],
            tagSelections: [
                { id: 100, tag: 'kept', libraryId: 1, type: 0, color: '' },
            ],
        });
    });

    it('leaves filters unchanged when every scoped object is searchable', () => {
        vi.stubGlobal('Zotero', {
            Collections: {
                get: vi.fn((id: number) => ({ id, libraryID: 1 })),
            },
        });

        const state = filters({
            libraryIds: [1],
            collectionIds: [10],
            tagSelections: [
                { id: 100, tag: 'kept', libraryId: 1, type: 0, color: '' },
            ],
        });
        const result = sanitizeMessageFiltersForSearchableLibraries(state, [1]);

        expect(result.changed).toBe(false);
        expect(result.state).toEqual(state);
    });
});
