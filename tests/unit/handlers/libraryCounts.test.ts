import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

import { getLibrarySummaries } from '../../../src/services/agentDataProvider/libraryCounts';
import { logger } from '@beaver/agent-core/platform/logger';

function rowWithCount(count: number) {
    return {
        getResultByIndex: vi.fn(() => count),
    };
}

/**
 * True for the aggregate queries behind `versions`, which run alongside the
 * counts and read several columns from one row.
 */
function isVersionQuery(sql: string): boolean {
    return sql.includes('MAX(collectionID)') || sql.includes('COUNT(DISTINCT IT.tagID)');
}

describe('getLibrarySummaries', () => {
    const queryAsync = vi.fn();
    const getAllLibraries = vi.fn();
    const getAllTags = vi.fn();
    const getColors = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();

        const zotero = (globalThis as any).Zotero;
        zotero.DB = { queryAsync };
        zotero.Tags = { getAll: getAllTags, getColors };
        zotero.Libraries.getAll = getAllLibraries;
        getColors.mockReturnValue(new Map());
    });

    it('returns sorted count summaries for requested libraries', async () => {
        const noteCountSql: string[] = [];
        const attachmentCountSql: string[] = [];
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
                if (isVersionQuery(sql)) {
                    options?.onRow?.(rowWithCount(libraryId));
                    return;
                }
                if (sql.includes('LEFT JOIN itemNotes')) {
                    count = libraryId === 1 ? 12 : 4;
                } else if (sql.includes('JOIN itemAttachments IA')) {
                    attachmentCountSql.push(sql);
                    count = libraryId === 1 ? 8 : 0;
                } else if (sql.includes('JOIN itemNotes N')) {
                    noteCountSql.push(sql);
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
                standalone_attachment_count: 8,
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
                standalone_attachment_count: 0,
                note_count: 1,
                collection_count: 2,
                tag_count: 1,
            },
        ]);
        expect(noteCountSql).toHaveLength(2);
        for (const sql of noteCountSql) {
            expect(sql).toContain('N.parentItemID IS NULL');
            expect(sql).toContain(
                'N.parentItemID NOT IN (SELECT itemID FROM deletedItems)'
            );
        }
        // Only top-level files count: an attachment under an item is reached
        // through that item, and is already covered by its parent's row.
        expect(attachmentCountSql).toHaveLength(2);
        for (const sql of attachmentCountSql) {
            expect(sql).toContain('IA.parentItemID IS NULL');
            expect(sql).toContain('NOT IN (SELECT itemID FROM deletedItems)');
        }
    });

    it('computes the cache-freshness markers only when they are asked for', async () => {
        // The application-state snapshot shares this helper and runs on every
        // message, where the markers would be pure cost.
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
            async (_sql: string, params: number[], options?: { onRow?: (row: any) => void }) => {
                options?.onRow?.(rowWithCount(params[0]));
            }
        );
        getAllTags.mockResolvedValue([]);

        const [withoutVersions] = await getLibrarySummaries([1]);
        expect(withoutVersions.versions).toBeUndefined();
        expect(queryAsync.mock.calls.some(([sql]) => isVersionQuery(sql))).toBe(false);

        const [withVersions] = await getLibrarySummaries([1], true);
        expect(withVersions.versions?.collections).toBeTruthy();
        expect(withVersions.versions?.tags).toBeTruthy();
    });

    it('reports a library holding only loose files as non-empty', async () => {
        getAllLibraries.mockReturnValue([
            {
                libraryID: 1,
                name: 'Unfiled PDFs',
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
                options?.onRow?.(
                    rowWithCount(sql.includes('JOIN itemAttachments IA') ? 40 : 0)
                );
            }
        );
        getAllTags.mockResolvedValue([]);

        const [summary] = await getLibrarySummaries([1]);

        expect(summary.item_count).toBe(0);
        expect(summary.standalone_attachment_count).toBe(40);
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
                if (sql.includes('JOIN itemAttachments IA')) {
                    throw new Error('attachments failed');
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
                standalone_attachment_count: 0,
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
            expect.stringContaining('Error counting standalone attachments'),
            2
        );
        expect(logger).toHaveBeenCalledWith(
            expect.stringContaining('Error counting tags'),
            2
        );
    });
});
