/**
 * The row-action link builder, and the rule that it can never fail a render.
 *
 * `zoteroLinksFor` is handed to `buildTableDocument`, which every write to a
 * stored table goes through, and it is called once per row while the document
 * is being built. So it is not merely a place where an exception would be
 * inconvenient: an exception here rejects `writeTable` before anything is
 * written, with an error that names none of this.
 *
 * Two of its lookups throw on perfectly ordinary items, both from
 * `Zotero.Item::getAttachments`: unconditionally when the item *is* an
 * attachment, and with an unloaded-data error when the item's child items have
 * not been loaded — which is true of any item nothing has touched this session.
 * Neither can be pre-empted, because this is synchronous and there is no point
 * at which a load could be awaited.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TableSpec } from '@beaver/agent-core/layouts/table';
import { buildTableDocument } from '../../../src/services/artifacts/tableDocument';
import { zoteroLinksFor } from '../../../src/services/artifacts/view/tableLinks';

const LIBRARY_ID = 1;

let savedZotero: any;

/** An item whose `getAttachments()` behaves the way `behaviour` says. */
function itemWith(behaviour: () => number[]): any {
    return { getAttachments: behaviour };
}

/** Zotero's own error for a data type that was never loaded. */
function unloadedData(): never {
    throw new Error("Item data 'childItems' not loaded");
}

function stubItems(items: Record<string, any>): void {
    (globalThis as any).Zotero = {
        ...savedZotero,
        Libraries: { ...savedZotero.Libraries, userLibraryID: LIBRARY_ID },
        Groups: { getGroupIDFromLibraryID: vi.fn(() => 0) },
        Items: {
            getByLibraryAndKey: vi.fn(
                (libraryID: number, key: string) =>
                    (libraryID === LIBRARY_ID && items[key]) || false
            ),
        },
    };
}

/** A table whose rows point at library items and offer both row actions. */
function specWithRows(keys: string[]): TableSpec {
    return {
        id: 'demo',
        title: 'Demo table',
        capabilities: { row_actions: ['reveal', 'open'] },
        columns: [{ id: 'note', header: 'Note', type: 'text' }],
        rows: keys.map((key, index) => ({
            id: `r${index}`,
            ref: { kind: 'item', library_id: LIBRARY_ID, zotero_key: key },
            cells: {
                note: { value: { kind: 'text', text: key }, provenance: 'asserted' },
            },
        })),
    };
}

beforeEach(() => {
    savedZotero = (globalThis as any).Zotero;
});

afterEach(() => {
    (globalThis as any).Zotero = savedZotero;
});

describe('zoteroLinksFor', () => {
    it('offers an open link for an item that has a file', () => {
        stubItems({ AAA: itemWith(() => [11]) });

        expect(
            zoteroLinksFor({ kind: 'item', library_id: LIBRARY_ID, zotero_key: 'AAA' })
        ).toEqual({
            selectUri: 'zotero://select/library/items/AAA',
            openUri: 'zotero://open/library/items/AAA',
        });
    });

    it('still reveals a row whose item is itself an attachment', () => {
        // `getAttachments()` throws unconditionally on an attachment, and a row
        // may legitimately reference one.
        stubItems({
            BBB: itemWith(() => {
                throw new Error('getAttachments() cannot be called on attachment items');
            }),
        });

        expect(
            zoteroLinksFor({ kind: 'item', library_id: LIBRARY_ID, zotero_key: 'BBB' })
        ).toEqual({
            selectUri: 'zotero://select/library/items/BBB',
            openUri: null,
        });
    });

    it('still reveals a row whose item has unloaded child items', () => {
        stubItems({ CCC: itemWith(unloadedData) });

        expect(
            zoteroLinksFor({ kind: 'item', library_id: LIBRARY_ID, zotero_key: 'CCC' })
        ).toEqual({
            selectUri: 'zotero://select/library/items/CCC',
            openUri: null,
        });
    });

    it('offers nothing for a row that names no library item', () => {
        stubItems({});
        expect(zoteroLinksFor({ kind: 'external', url: 'https://example.org' })).toEqual({});
    });
});

describe('rendering a table whose rows cannot be asked about their files', () => {
    it('renders rather than throwing, so the write is not lost', () => {
        stubItems({
            AAA: itemWith(() => [11]),
            BBB: itemWith(() => {
                throw new Error('getAttachments() cannot be called on attachment items');
            }),
            CCC: itemWith(unloadedData),
        });

        const document = buildTableDocument(specWithRows(['AAA', 'BBB', 'CCC']), {
            linksFor: zoteroLinksFor,
        });

        // Every row is revealable; only the one that could answer gets an open
        // link. A row that could not answer costs its open link and nothing more.
        for (const key of ['AAA', 'BBB', 'CCC']) {
            expect(document.html).toContain(`zotero://select/library/items/${key}`);
        }
        expect(document.html).toContain('zotero://open/library/items/AAA');
        expect(document.html).not.toContain('zotero://open/library/items/BBB');
        expect(document.html).not.toContain('zotero://open/library/items/CCC');
    });

    it('asks for a row\'s links once, not once per place they are shown', () => {
        stubItems({ AAA: itemWith(() => [11]), BBB: itemWith(() => []) });
        const linksFor = vi.fn(zoteroLinksFor);

        buildTableDocument(specWithRows(['AAA', 'BBB']), { linksFor });

        // The actions cell and the expanded detail show the same links, and
        // this is a live Zotero lookup per row on every write.
        expect(linksFor).toHaveBeenCalledTimes(2);
    });
});
