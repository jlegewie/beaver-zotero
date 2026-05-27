import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

import { getLibrarySummaries } from '../../../src/services/agentDataProvider/libraryCounts';
import { logger } from '../../../src/utils/logger';

function rowWithCount(count: number) {
    return {
        getResultByIndex: vi.fn(() => count),
    };
}

describe('getLibrarySummaries', () => {
    const queryAsync = vi.fn();
    const getAllLibraries = vi.fn();
    const getAllTags = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();

        const zotero = (globalThis as any).Zotero;
        zotero.DB = { queryAsync };
        zotero.Tags = { getAll: getAllTags };
        zotero.Libraries.getAll = getAllLibraries;
    });

    it('returns sorted count summaries for requested libraries', async () => {
        getAllLibraries.mockReturnValue([
            {
                libraryID: 2,
                name: 'Group Library',
                isGroup: true,
                editable: true,
                filesEditable: false,
            },
            {
                libraryID: 1,
                name: 'My Library',
                isGroup: false,
                editable: true,
                filesEditable: true,
            },
            {
                libraryID: 3,
                name: 'Skipped Library',
                isGroup: false,
                editable: true,
                filesEditable: true,
            },
        ]);
        queryAsync.mockImplementation(
            async (
                sql: string,
                params: number[],
                options?: { onRow?: (row: any) => void }
            ) => {
                const libraryId = params[0];
                let count = 0;
                if (sql.includes('LEFT JOIN itemNotes')) {
                    count = libraryId === 1 ? 12 : 4;
                } else if (sql.includes('JOIN itemNotes N')) {
                    count = libraryId === 1 ? 5 : 1;
                } else if (sql.includes('FROM collections')) {
                    count = libraryId === 1 ? 3 : 2;
                }
                options?.onRow?.(rowWithCount(count));
            }
        );
        getAllTags.mockImplementation(async (libraryId: number) => (
            libraryId === 1 ? [{ tag: 'a' }, { tag: 'b' }] : [{ tag: 'c' }]
        ));

        await expect(getLibrarySummaries([1, 2])).resolves.toEqual([
            {
                library_id: 1,
                name: 'My Library',
                is_group: false,
                read_only: false,
                item_count: 12,
                note_count: 5,
                collection_count: 3,
                tag_count: 2,
            },
            {
                library_id: 2,
                name: 'Group Library',
                is_group: true,
                read_only: true,
                item_count: 4,
                note_count: 1,
                collection_count: 2,
                tag_count: 1,
            },
        ]);
    });

    it('isolates count failures to the failed count', async () => {
        getAllLibraries.mockReturnValue([
            {
                libraryID: 1,
                name: 'My Library',
                isGroup: false,
                editable: true,
                filesEditable: true,
            },
        ]);
        queryAsync.mockImplementation(
            async (
                sql: string,
                _params: number[],
                options?: { onRow?: (row: any) => void }
            ) => {
                if (sql.includes('JOIN itemNotes N')) {
                    throw new Error('notes failed');
                }
                if (sql.includes('LEFT JOIN itemNotes')) {
                    options?.onRow?.(rowWithCount(12));
                    return;
                }
                options?.onRow?.(rowWithCount(3));
            }
        );
        getAllTags.mockRejectedValue(new Error('tags failed'));

        await expect(getLibrarySummaries([1])).resolves.toEqual([
            {
                library_id: 1,
                name: 'My Library',
                is_group: false,
                read_only: false,
                item_count: 12,
                note_count: 0,
                collection_count: 3,
                tag_count: 0,
            },
        ]);
        expect(logger).toHaveBeenCalledWith(
            expect.stringContaining('Error counting notes'),
            2
        );
        expect(logger).toHaveBeenCalledWith(
            expect.stringContaining('Error counting tags'),
            2
        );
    });
});
