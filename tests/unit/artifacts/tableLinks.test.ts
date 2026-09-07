/**
 * The row-action link builder, and the rule that it can never fail a render.
 *
 * `zoteroLinksFor` is handed to `buildTableDocument`, which every write to a
 * stored table goes through, and it is called once per row while the document
 * is being built. So an exception here rejects `writeTable` before anything is
 * written, with an error that names none of this. Nothing here asks Zotero
 * about an item: every target comes from the spec, and the only lookup is the
 * library's URI scope.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Row, TableSpec } from '@beaver/agent-core/layouts/table';
import { buildTableDocument } from '../../../src/services/artifacts/tableDocument';
import {
    rowActionHref,
    zoteroLinkScope,
    zoteroLinksFor,
} from '../../../src/services/artifacts/view/tableLinks';

const LIBRARY_ID = 1;
const GROUP_LIBRARY_ID = 7;
const GROUP_ID = 4242;

let savedZotero: any;

function stubLibraries(): void {
    (globalThis as any).Zotero = {
        ...savedZotero,
        Libraries: {
            ...savedZotero.Libraries,
            userLibraryID: LIBRARY_ID,
            get: vi.fn((id: number) => {
                if (id === LIBRARY_ID) return { libraryType: 'user' };
                if (id === GROUP_LIBRARY_ID)
                    return { libraryType: 'group', groupID: GROUP_ID };
                return false;
            }),
        },
    };
}

function row(ref: Row['ref']): Row {
    return { id: 'r', ref, cells: {} };
}

beforeEach(() => {
    savedZotero = (globalThis as any).Zotero;
    stubLibraries();
});

afterEach(() => {
    (globalThis as any).Zotero = savedZotero;
});

describe('zoteroLinksFor', () => {
    it('links an item row to its named file, and only reveals one without', () => {
        expect(
            zoteroLinksFor(
                row({
                    kind: 'item',
                    library_id: LIBRARY_ID,
                    zotero_key: 'AAA',
                    attachment: { library_id: LIBRARY_ID, zotero_key: 'FFF' },
                })
            )
        ).toEqual({
            reveal: 'zotero://select/library/items/AAA',
            // `zotero://open` accepts only a file attachment, so the link names
            // the file, not the item.
            open: 'zotero://open/library/items/FFF',
        });
        expect(
            zoteroLinksFor(row({ kind: 'item', library_id: LIBRARY_ID, zotero_key: 'BBB' }))
        ).toEqual({ reveal: 'zotero://select/library/items/BBB' });
    });

    it('opens an attachment row itself', () => {
        expect(
            zoteroLinksFor(row({ kind: 'attachment', library_id: LIBRARY_ID, zotero_key: 'FFF' }))
        ).toEqual({
            reveal: 'zotero://select/library/items/FFF',
            open: 'zotero://open/library/items/FFF',
        });
    });

    it('opens an annotation row in the reader on its attachment, and reveals its item', () => {
        expect(
            zoteroLinksFor(
                row({
                    kind: 'annotation',
                    library_id: LIBRARY_ID,
                    zotero_key: 'ANN',
                    attachment: { library_id: LIBRARY_ID, zotero_key: 'FFF' },
                    parent_item: { library_id: LIBRARY_ID, zotero_key: 'AAA' },
                })
            )
        ).toEqual({
            reveal: 'zotero://select/library/items/AAA',
            open: 'zotero://open/library/items/FFF?annotation=ANN',
        });
    });

    it('offers nothing a static document cannot do: import, or a file the host resolves', () => {
        expect(zoteroLinksFor(row({ kind: 'file', ext_key: 'AB12CD34' }))).toEqual({});
        expect(
            zoteroLinksFor(
                row({
                    kind: 'external',
                    source: 'openalex',
                    source_id: 'W1',
                    reference: { source: 'openalex', source_id: 'W1', library_items: [] },
                })
            )
        ).toEqual({});
        expect(rowActionHref({ kind: 'open_external_file', ext_key: 'AB12CD34' })).toBeNull();
        expect(
            rowActionHref({ kind: 'open_item', ref: { library_id: LIBRARY_ID, zotero_key: 'AAA' } })
        ).toBeNull();
    });

    it('names the group in a group library row, not `library`', () => {
        expect(
            zoteroLinksFor(row({ kind: 'item', library_id: GROUP_LIBRARY_ID, zotero_key: 'GGG' }))
        ).toEqual({ reveal: `zotero://select/groups/${GROUP_ID}/items/GGG` });
    });
});

describe('zoteroLinkScope', () => {
    it('answers the group scope for a group library and `library` for the personal one', () => {
        expect(zoteroLinkScope(LIBRARY_ID)).toBe('library');
        expect(zoteroLinkScope(GROUP_LIBRARY_ID)).toBe(`groups/${GROUP_ID}`);
    });

    it('degrades to the personal library rather than throwing on an unknown one', () => {
        // Handed to `buildTableDocument` on every write: a throw here would
        // abort a write over an unknown library.
        expect(zoteroLinkScope(404)).toBe('library');
    });
});

describe('a citation into a group library', () => {
    it('gets a link that resolves, not one under `library/`', () => {
        const spec: TableSpec = {
            id: 'c',
            columns: [{ id: 'finding', header: 'Finding', type: 'text' }],
            rows: [
                {
                    id: 'r1',
                    cells: {
                        finding: {
                            value: {
                                kind: 'text',
                                text: 'Rose 13%. <citation id="g4242-K1" loc="page4"/>',
                            },
                        },
                    },
                },
            ],
            citations: [
                {
                    citation_id: 'c1',
                    raw_tag: '<citation id="g4242-K1" loc="page4"/>',
                    display_name: 'Bloom 2015',
                    pages: [4],
                    resolved_ref: {
                        kind: 'zotero',
                        library_id: GROUP_LIBRARY_ID,
                        library_ref: `g${GROUP_ID}`,
                        zotero_key: 'K1',
                    },
                },
            ],
        };

        const { html } = buildTableDocument(spec, {
            linksFor: zoteroLinksFor,
            citationScopeFor: zoteroLinkScope,
        });

        expect(html).toContain(`zotero://open/groups/${GROUP_ID}/items/K1?page=4`);
        expect(html).not.toContain('zotero://open/library/items/K1');
    });
});

describe('a stored table with rows of every kind', () => {
    it('draws each row the verbs it has links for, and asks for them once per row', () => {
        const spec: TableSpec = {
            id: 'demo',
            capabilities: { row_actions: ['reveal', 'open', 'import'] },
            columns: [{ id: 'note', header: 'Note', type: 'text' }],
            rows: [
                row({
                    kind: 'item',
                    library_id: LIBRARY_ID,
                    zotero_key: 'AAA',
                    attachment: { library_id: LIBRARY_ID, zotero_key: 'FFF' },
                }),
                { ...row({ kind: 'file', ext_key: 'AB12CD34' }), id: 'file' },
            ].map((r, i) => ({ ...r, id: `r${i}` })),
        };
        const linksFor = vi.fn(zoteroLinksFor);

        const document = buildTableDocument(spec, { linksFor });

        expect(document.html).toContain('zotero://select/library/items/AAA');
        expect(document.html).toContain('zotero://open/library/items/FFF');
        // The actions cell and the expanded detail show the same links.
        expect(linksFor).toHaveBeenCalledTimes(2);
    });
});
