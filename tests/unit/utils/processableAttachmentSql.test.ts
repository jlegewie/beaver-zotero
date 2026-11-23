import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { createMockAttachment } from '../../helpers/factories';
import {
    processableAttachmentSql,
    processableKindFromStoredFields,
} from '../../../src/utils/attachmentFiles';
import { getReadableContentKind } from '../../../src/services/documentExtraction/attachmentResolution';
import { isTableAttachment, TABLE_URL_PREFIX } from '../../../src/services/artifacts/tableItemIdentity';

type ReadableItem = Parameters<typeof getReadableContentKind>[0];

const CONTENT_TYPES = [
    'application/pdf', 'APPLICATION/PDF', 'application/pdf; charset=binary', ' application/x-pdf ',
    'text/pdf', 'application/epub+zip', 'application/epub', 'text/html', 'TEXT/HTML',
    'application/xhtml+xml', 'text/html; charset=utf-8', '', null, 'application/octet-stream',
    'binary/octet-stream', 'application/msword', 'text/plain', 'image/png',
];
const PATHS = [
    'storage:paper.pdf', 'storage:Book.EPUB', '/Users/me/linked/report.pdf',
    'storage:data', 'storage:page.html', 'storage:archive.pdf.zip', null,
];

const basename = (path: string | null) => path?.replace(/^storage:/, '').split('/').pop() ?? null;

function readableKind(contentType: string | null, path: string | null): string | null {
    const item = {
        ...createMockAttachment({ path: path ?? undefined, linkMode: 0 }),
        attachmentContentType: contentType,
        attachmentFilename: basename(path),
    } as unknown as ReadableItem;
    const kind = getReadableContentKind(item);
    return kind === 'pdf' || kind === 'epub' || kind === 'snapshot' ? kind : null;
}

describe('processable attachment SQL', () => {
    let db: MockDBConnection;

    beforeEach(async () => {
        db = new MockDBConnection();
        await db.queryAsync(`CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY,
            parentItemID INTEGER, linkMode INTEGER, contentType TEXT, path TEXT)`);
        await db.queryAsync('CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT)');
        await db.queryAsync('CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value)');
        await db.queryAsync('CREATE TABLE itemData (itemID INT, fieldID INT, valueID, PRIMARY KEY (itemID, fieldID))');
        await db.queryAsync("INSERT INTO fields VALUES (1, 'url'), (2, 'title')");
    });
    afterEach(async () => { await db.closeDatabase(); });

    it('selects exactly the attachments item-level classification admits', async () => {
        const cases: Array<{ id: number; contentType: string | null; path: string | null }> = [];
        for (const contentType of CONTENT_TYPES) {
            for (const path of PATHS) {
                const id = cases.length + 1;
                cases.push({ id, contentType, path });
                await db.queryAsync('INSERT INTO itemAttachments (itemID, linkMode, contentType, path) VALUES (?, 0, ?, ?)', [id, contentType, path]);
            }
        }
        const selected = new Set<number>();
        await db.queryAsync(
            `SELECT IA.itemID FROM itemAttachments IA WHERE ${processableAttachmentSql('IA')}`,
            [],
            { onRow: (row: any) => selected.add(row.getResultByIndex(0)) },
        );

        for (const { id, contentType, path } of cases) {
            const storedKind = processableKindFromStoredFields(contentType, path);
            expect({ contentType, path, kind: storedKind })
                .toEqual({ contentType, path, kind: readableKind(contentType, path) });
            expect({ contentType, path, selected: selected.has(id) })
                .toEqual({ contentType, path, selected: storedKind !== null });
        }
    });

    it('leaves out exactly the snapshots isTableAttachment identifies as Beaver tables', async () => {
        const tableUrl = `${TABLE_URL_PREFIX}my-table`;
        const cases = [
            { id: 1, parent: null, linkMode: 1, contentType: 'text/html', url: tableUrl },
            { id: 2, parent: null, linkMode: 1, contentType: 'text/html', url: 'https://example.org/page' },
            { id: 3, parent: null, linkMode: 1, contentType: 'text/html', url: null },
            { id: 4, parent: 99, linkMode: 1, contentType: 'text/html', url: tableUrl },
            { id: 5, parent: null, linkMode: 0, contentType: 'text/html', url: tableUrl },
            { id: 6, parent: null, linkMode: 1, contentType: 'application/xhtml+xml', url: tableUrl },
        ];
        for (const { id, parent, linkMode, contentType, url } of cases) {
            await db.queryAsync('INSERT INTO itemAttachments VALUES (?, ?, ?, ?, ?)',
                [id, parent, linkMode, contentType, 'storage:page.html']);
            if (url) {
                await db.queryAsync('INSERT INTO itemDataValues VALUES (?, ?)', [id, url]);
                await db.queryAsync('INSERT INTO itemData VALUES (?, 1, ?)', [id, id]);
            }
        }
        const selected = new Set<number>();
        await db.queryAsync(`SELECT IA.itemID FROM itemAttachments IA WHERE ${processableAttachmentSql('IA')}`, [],
            { onRow: (row: any) => selected.add(row.getResultByIndex(0)) });

        for (const { id, parent, linkMode, contentType, url } of cases) {
            const item = {
                isAttachment: () => true,
                isTopLevelItem: () => parent === null,
                attachmentLinkMode: linkMode,
                attachmentContentType: contentType,
                getField: (field: string) => (field === 'url' ? url ?? '' : ''),
            } as unknown as Zotero.Item;
            expect({ id, selected: selected.has(id) }).toEqual({ id, selected: !isTableAttachment(item) });
        }
        expect(selected.has(1)).toBe(false);
    });

    it('classifies mislabelled documents from the stored path extension', () => {
        expect(processableKindFromStoredFields('application/octet-stream', 'storage:paper.pdf')).toBe('pdf');
        expect(processableKindFromStoredFields(null, '/Users/me/Book.EPUB')).toBe('epub');
        expect(processableKindFromStoredFields('application/x-pdf', 'storage:data')).toBe('pdf');
        expect(processableKindFromStoredFields('application/msword', 'storage:paper.pdf')).toBeNull();
        expect(processableKindFromStoredFields('text/html', 'storage:page.html')).toBe('snapshot');
    });
});
