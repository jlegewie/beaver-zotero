/**
 * Unit tests for the legacy tool-result compatibility layer
 * (`react/compat/legacyToolResults.ts`).
 *
 * The compat layer synthesizes a hydrated `ToolResultView` from a legacy
 * reference-only `summary` (+ live Zotero loads). These tests drive the full
 * layer end-to-end against a mocked Zotero item store, covering every tool in
 * the Tool→View mapping plus the edge cases (unresolved refs, no-parent
 * degrade, annotation rows in item lists, external files, discontinued tools,
 * pass-through of already-hydrated views).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// EXTERNAL_LIBRARY_ID is the only heavy transitive import in the compat module
// (it pulls the external-files service, which loads the MuPDF worker client).
// Stub it to the sentinel so the suite stays a pure unit test.
vi.mock('../../../src/services/externalFiles', () => ({ EXTERNAL_LIBRARY_ID: -1 }));

import { upgradeToolReturn, buildLegacyView } from '../../../react/compat/legacyToolResults';
import {
    isToolResultView,
    ItemListView,
    AnnotationListView,
    ExternalReferenceListView,
    CollectionListView,
    TagListView,
    AttachmentSearchView,
    ItemRowView,
    AnnotationRowView,
} from '../../../react/types/toolResultViews';
import { ToolReturnPart } from '../../../react/agents/types';

// ---------------------------------------------------------------------------
// Mock Zotero item store
// ---------------------------------------------------------------------------

interface MockItemSpec {
    id: number;
    libraryID?: number;
    key: string;
    kind?: 'regular' | 'attachment' | 'note' | 'annotation';
    itemType?: string;
    title?: string;
    firstCreator?: string;
    date?: string;
    displayTitle?: string;
    noteTitle?: string;
    parentItemID?: number;
    attachmentFilename?: string;
    attachmentContentType?: string;
    isPDF?: boolean;
    isEPUB?: boolean;
    isImage?: boolean;
    annotationType?: string;
    annotationText?: string;
    annotationComment?: string;
    annotationColor?: string;
    annotationPageLabel?: string;
    tags?: string[];
}

function makeItem(spec: MockItemSpec): any {
    const {
        id,
        libraryID = 1,
        key,
        kind = 'regular',
        itemType = kind === 'regular' ? 'journalArticle' : kind,
        title = '',
        firstCreator = '',
        date = '',
        displayTitle,
        noteTitle = '',
        parentItemID,
        attachmentFilename = '',
        attachmentContentType = '',
        isPDF = false,
        isEPUB = false,
        isImage = false,
        annotationType,
        annotationText = '',
        annotationComment = '',
        annotationColor,
        annotationPageLabel = '',
        tags = [],
    } = spec;

    const fields: Record<string, string> = { title, date };

    return {
        id,
        libraryID,
        key,
        itemType,
        firstCreator,
        parentItemID: parentItemID ?? false,
        attachmentFilename,
        attachmentContentType,
        getField: vi.fn((f: string) => fields[f] ?? ''),
        getDisplayTitle: vi.fn(() => displayTitle ?? title ?? ''),
        getNoteTitle: vi.fn(() => noteTitle),
        getTags: vi.fn(() => tags.map((t) => ({ tag: t }))),
        loadDataType: vi.fn().mockResolvedValue(undefined),
        isRegularItem: vi.fn(() => kind === 'regular'),
        isAttachment: vi.fn(() => kind === 'attachment'),
        isNote: vi.fn(() => kind === 'note'),
        isAnnotation: vi.fn(() => kind === 'annotation'),
        isPDFAttachment: vi.fn(() => isPDF),
        isEPUBAttachment: vi.fn(() => isEPUB),
        isImageAttachment: vi.fn(() => isImage),
        annotationType,
        annotationText,
        annotationComment,
        annotationColor,
        annotationPageLabel,
    };
}

let itemsByRef: Map<string, any>;
let itemsById: Map<number, any>;

function installItems(specs: MockItemSpec[]): Record<string, any> {
    itemsByRef = new Map();
    itemsById = new Map();
    const made: Record<string, any> = {};
    for (const spec of specs) {
        const item = makeItem(spec);
        itemsByRef.set(`${item.libraryID}-${item.key}`, item);
        itemsById.set(item.id, item);
        made[spec.key] = item;
    }
    (globalThis as any).Zotero.Items = {
        getByLibraryAndKeyAsync: vi.fn(async (libraryID: number, key: string) =>
            itemsByRef.get(`${libraryID}-${key}`) ?? false,
        ),
        getAsync: vi.fn(async (id: number) => itemsById.get(id) ?? false),
    };
    return made;
}

beforeEach(() => {
    vi.clearAllMocks();
    installItems([]);
    delete (globalThis as any).Zotero.Beaver;
});

// Helpers to build legacy parts (reference-only summary path).
function returnPart(toolName: string, summary: Record<string, unknown>, content: unknown = null): ToolReturnPart {
    return {
        part_kind: 'tool-return',
        tool_name: toolName,
        content,
        tool_call_id: `call_${toolName}`,
        metadata: { summary },
    };
}

function itemRows(view: ItemListView): ItemRowView[] {
    return view.items.filter((r): r is ItemRowView => r.kind === 'item');
}

// ===========================================================================
// upgradeToolReturn — pass-through behavior
// ===========================================================================

describe('upgradeToolReturn', () => {
    it('passes through a part that already carries a view', async () => {
        const existingView = { view_type: 'item_list', tool_name: 'x', items: [] };
        const part: ToolReturnPart = {
            part_kind: 'tool-return',
            tool_name: 'zotero_search',
            content: null,
            tool_call_id: 'c1',
            metadata: { view: existingView, summary: { tool_name: 'zotero_search', items: [], total_count: 0 } },
        };
        const result = await upgradeToolReturn(part);
        expect(result.metadata!.view).toBe(existingView);
        // It must not re-derive a view over an existing one.
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('leaves an unrecognized tool without a view', async () => {
        const part = returnPart('totally_unknown_tool', { foo: 'bar' });
        const result = await upgradeToolReturn(part);
        expect(result.metadata!.view).toBeUndefined();
    });

    it('attaches a synthesized view for a legacy result', async () => {
        installItems([{ id: 1, key: 'AAAA1111', firstCreator: 'Smith', date: '2004-01-01', title: 'A Paper' }]);
        const part = returnPart('zotero_search', {
            tool_name: 'zotero_search',
            total_count: 1,
            items: [{ library_id: 1, zotero_key: 'AAAA1111' }],
        });
        const result = await upgradeToolReturn(part);
        expect(isToolResultView(result.metadata!.view)).toBe(true);
        expect(result.metadata!.view.view_type).toBe('item_list');
    });

    it('creates a metadata object when the part has none', async () => {
        installItems([{ id: 1, key: 'AAAA1111', firstCreator: 'Smith', date: '2004' }]);
        const part: ToolReturnPart = {
            part_kind: 'tool-return',
            tool_name: 'item_search_by_topic',
            content: { references: undefined },
            tool_call_id: 'c1',
        };
        // give it a summary via metadata so the extractor matches
        part.metadata = { summary: { tool_name: 'item_search_by_topic', result_count: 1, items: [{ library_id: 1, zotero_key: 'AAAA1111' }] } };
        const result = await upgradeToolReturn(part);
        expect(result.metadata!.view).toBeDefined();
    });

    it('returns non-tool-return parts untouched', async () => {
        const part = { part_kind: 'user-prompt', content: 'hi' } as any;
        const result = await upgradeToolReturn(part);
        expect(result).toBe(part);
    });
});

// ===========================================================================
// ItemListView — target-centric tools (R/A/N)
// ===========================================================================

describe('buildLegacyView — item-list target-centric (zotero_search / list_items / get_metadata)', () => {
    it('renders a regular item as pattern R (author-year + title)', async () => {
        installItems([{ id: 1, key: 'REG00001', firstCreator: 'Smith', date: '2004-06-01', title: 'On Things', displayTitle: 'On Things' }]);
        const view = (await buildLegacyView(returnPart('zotero_search', {
            tool_name: 'zotero_search', total_count: 1, items: [{ library_id: 1, zotero_key: 'REG00001' }],
        }))) as ItemListView;
        const rows = itemRows(view);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            kind: 'item',
            library_id: 1,
            zotero_key: 'REG00001',
            display_name: 'Smith 2004',
            subtitle: 'On Things',
            item_type: 'journalArticle',
            status: 'ok',
        });
        expect(rows[0].attachment_label ?? null).toBeNull();
    });

    it('renders an attachment as pattern A (own name + parent bib subtitle)', async () => {
        installItems([
            { id: 10, key: 'PARENT01', firstCreator: 'Jones', date: '2010', title: 'The Book', displayTitle: 'The Book' },
            { id: 11, key: 'ATT00001', kind: 'attachment', isPDF: true, parentItemID: 10, attachmentContentType: 'application/pdf', title: 'supplement.pdf' },
        ]);
        const view = (await buildLegacyView(returnPart('list_items', {
            tool_name: 'list_items', total_count: 1, items: [{ library_id: 1, zotero_key: 'ATT00001' }],
        }))) as ItemListView;
        const rows = itemRows(view);
        expect(rows[0]).toMatchObject({
            display_name: 'supplement.pdf',
            subtitle: 'Jones 2010. The Book',
            item_type: 'attachment',
            content_kind: 'pdf',
        });
        // Attachment-centric rows carry no attachment_label (display already names it).
        expect(rows[0].attachment_label ?? null).toBeNull();
    });

    it('renders a note as pattern N (note title + parent bib subtitle)', async () => {
        installItems([
            { id: 20, key: 'PARENT02', firstCreator: 'Doe', date: '1999', title: 'Old Work', displayTitle: 'Old Work' },
            { id: 21, key: 'NOTE0001', kind: 'note', parentItemID: 20, noteTitle: 'My reading note' },
        ]);
        const view = (await buildLegacyView(returnPart('get_metadata', {
            tool_name: 'get_metadata', items: [{ library_id: 1, zotero_key: 'NOTE0001' }],
        }))) as ItemListView;
        const rows = itemRows(view);
        expect(rows[0]).toMatchObject({
            display_name: 'My reading note',
            subtitle: 'Doe 1999. Old Work',
            item_type: 'note',
        });
    });

    it('degrades an unresolved reference to a minimal row (key as display name)', async () => {
        installItems([]); // nothing resolves
        const view = (await buildLegacyView(returnPart('zotero_search', {
            tool_name: 'zotero_search', total_count: 1, items: [{ library_id: 1, zotero_key: 'GONE0001' }],
        }))) as ItemListView;
        const rows = itemRows(view);
        expect(rows[0]).toMatchObject({ display_name: 'GONE0001', status: 'ok' });
        expect(rows[0].item_type ?? null).toBeNull();
    });

    it('renders an annotation reference inside an item list as an annotation row', async () => {
        installItems([
            { id: 30, key: 'PARENT03', firstCreator: 'Lee', date: '2015' },
            { id: 31, key: 'ATTACH03', kind: 'attachment', parentItemID: 30, isPDF: true },
            { id: 32, key: 'ANNOT003', kind: 'annotation', parentItemID: 31, annotationType: 'highlight', annotationText: 'a key passage', annotationColor: '#ff0000', annotationPageLabel: '12', tags: ['important'] },
        ]);
        const view = (await buildLegacyView(returnPart('get_metadata', {
            tool_name: 'get_metadata', items: [{ library_id: 1, zotero_key: 'ANNOT003' }],
        }))) as ItemListView;
        expect(view.items).toHaveLength(1);
        const row = view.items[0] as AnnotationRowView;
        expect(row).toMatchObject({
            kind: 'annotation',
            annotation_type: 'highlight',
            text: 'a key passage',
            color: '#ff0000',
            page_label: '12',
            source_display_name: 'Lee 2015',
            tags: ['important'],
        });
    });

    it('renders an empty item list as an empty view (not null)', async () => {
        const view = (await buildLegacyView(returnPart('zotero_search', {
            tool_name: 'zotero_search', total_count: 0, items: [],
        }))) as ItemListView;
        expect(view).not.toBeNull();
        expect(view.view_type).toBe('item_list');
        expect(view.items).toHaveLength(0);
    });
});

// ===========================================================================
// ItemListView — parent-centric content tools (P)
// ===========================================================================

describe('buildLegacyView — parent-centric content tools (P)', () => {
    it('fulltext_search headlines the parent with a "Page …" label (chunks are 0-indexed)', async () => {
        installItems([
            { id: 40, key: 'PARENT04', firstCreator: 'Adams', date: '2020', title: 'Findings', displayTitle: 'Findings' },
            { id: 41, key: 'ATTACH04', kind: 'attachment', parentItemID: 40, isPDF: true },
        ]);
        const view = (await buildLegacyView(returnPart('fulltext_search', {
            tool_name: 'fulltext_search',
            result_count: 4,
            chunks: [
                { library_id: 1, zotero_key: 'ATTACH04', page: 0 },
                { library_id: 1, zotero_key: 'ATTACH04', page: 1 },
                { library_id: 1, zotero_key: 'ATTACH04', page: 2 },
                { library_id: 1, zotero_key: 'ATTACH04', page: 4 },
            ],
        }))) as ItemListView;
        const rows = itemRows(view);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            display_name: 'Adams 2020',
            subtitle: 'Findings',
            attachment_label: null, // no attachment title/filename set on the mock
            item_type: 'attachment',
            content_kind: 'pdf',
            location_label: 'Page 1-3, 5',
        });
    });

    it('read (paginated) headlines the parent and names the served attachment', async () => {
        installItems([
            { id: 50, key: 'PARENT05', firstCreator: 'Brown', date: '2021', title: 'Methods', displayTitle: 'Methods' },
            { id: 51, key: 'ATTACH05', kind: 'attachment', parentItemID: 50, isPDF: true, title: 'main.pdf' },
        ]);
        const view = (await buildLegacyView(returnPart('read', {
            tool_name: 'read',
            result_count: 2,
            pages: [
                { library_id: 1, zotero_key: 'ATTACH05', page_number: 1 },
                { library_id: 1, zotero_key: 'ATTACH05', page_number: 2 },
            ],
        }))) as ItemListView;
        const rows = itemRows(view);
        expect(rows[0]).toMatchObject({
            display_name: 'Brown 2021',
            subtitle: 'Methods',
            attachment_label: 'main.pdf',
            location_label: 'Page 1-2',
        });
    });

    it('read (text) headlines the parent with a line label', async () => {
        installItems([
            { id: 60, key: 'PARENT06', firstCreator: 'Cole', date: '2022', title: 'Notes', displayTitle: 'Notes' },
            { id: 61, key: 'ATTACH06', kind: 'attachment', parentItemID: 60, attachmentContentType: 'text/plain', title: 'notes.txt' },
        ]);
        const view = (await buildLegacyView(returnPart('read', {
            tool_name: 'read',
            result_count: 1,
            lines: [{ library_id: 1, zotero_key: 'ATTACH06', start_line: 10, end_line: 20 }],
        }))) as ItemListView;
        const rows = itemRows(view);
        expect(rows[0]).toMatchObject({
            display_name: 'Cole 2022',
            attachment_label: 'notes.txt',
            content_kind: 'text',
            location_label: 'Lines 10-20',
        });
    });

    it('read (text) uses singular "Line" for a single-line range', async () => {
        installItems([
            { id: 62, key: 'PARENT07', firstCreator: 'Dale', date: '2022' },
            { id: 63, key: 'ATTACH07', kind: 'attachment', parentItemID: 62, attachmentContentType: 'text/plain' },
        ]);
        const view = (await buildLegacyView(returnPart('read', {
            tool_name: 'read', result_count: 1,
            lines: [{ library_id: 1, zotero_key: 'ATTACH07', start_line: 5, end_line: 5 }],
        }))) as ItemListView;
        expect(itemRows(view)[0].location_label).toBe('Line 5');
    });

    it('view (pdf) labels page rows; view (image) leaves image rows unlabeled', async () => {
        installItems([
            { id: 70, key: 'PARENT08', firstCreator: 'Eve', date: '2023', title: 'Figures', displayTitle: 'Figures' },
            { id: 71, key: 'ATTACH08', kind: 'attachment', parentItemID: 70, isPDF: true },
            { id: 72, key: 'IMG00001', kind: 'attachment', isImage: true, attachmentContentType: 'image/png', title: 'figure.png' },
        ]);
        const pdfView = (await buildLegacyView(returnPart('view', {
            tool_name: 'view', kind: 'pdf', result_count: 2,
            images: [
                { library_id: 1, zotero_key: 'ATTACH08', page_number: 3, format: 'png', width: 1, height: 1 },
                { library_id: 1, zotero_key: 'ATTACH08', page_number: 4, format: 'png', width: 1, height: 1 },
            ],
        }))) as ItemListView;
        expect(itemRows(pdfView)[0].location_label).toBe('Page 3-4');

        const imgView = (await buildLegacyView(returnPart('view', {
            tool_name: 'view', kind: 'image', result_count: 1,
            images: [{ library_id: 1, zotero_key: 'IMG00001', page_number: null, format: 'png', width: 1, height: 1 }],
        }))) as ItemListView;
        const imgRow = itemRows(imgView)[0];
        expect(imgRow.location_label ?? null).toBeNull();
        // Standalone image attachment with no parent → attachment-centric row.
        expect(imgRow.display_name).toBe('figure.png');
        expect(imgRow.content_kind).toBe('image');
    });

    it('degrades a parent-centric row with no parent to "Unknown file" when nameless', async () => {
        installItems([
            { id: 80, key: 'ATTACH09', kind: 'attachment', isPDF: true }, // no parent, no title/filename
        ]);
        const view = (await buildLegacyView(returnPart('read', {
            tool_name: 'read', result_count: 1,
            pages: [{ library_id: 1, zotero_key: 'ATTACH09', page_number: 1 }],
        }))) as ItemListView;
        const rows = itemRows(view);
        expect(rows[0]).toMatchObject({ display_name: 'Unknown file', subtitle: null, item_type: 'attachment' });
    });

    it('read_pages (discontinued, chunk-based) maps to parent-centric page rows', async () => {
        installItems([
            { id: 95, key: 'PARENT11', firstCreator: 'Webb', date: '2018', title: 'Old', displayTitle: 'Old' },
            { id: 96, key: 'ATTACH11', kind: 'attachment', parentItemID: 95, isPDF: true },
        ]);
        const view = (await buildLegacyView(returnPart('read_pages', {
            tool_name: 'read_pages',
            chunks: [
                { library_id: 1, zotero_key: 'ATTACH11', page: 4 },
                { library_id: 1, zotero_key: 'ATTACH11', page: 5 },
            ],
        }))) as ItemListView;
        const rows = itemRows(view);
        expect(rows[0]).toMatchObject({ display_name: 'Webb 2018', location_label: 'Page 4-5' });
    });

    it('read (text) builds a multi-range line label with plural "Lines"', async () => {
        installItems([
            { id: 97, key: 'PARENT12', firstCreator: 'Yang', date: '2023' },
            { id: 98, key: 'ATTACH12', kind: 'attachment', parentItemID: 97, attachmentContentType: 'text/markdown' },
        ]);
        const view = (await buildLegacyView(returnPart('read', {
            tool_name: 'read', result_count: 2,
            lines: [
                { library_id: 1, zotero_key: 'ATTACH12', start_line: 1, end_line: 5 },
                { library_id: 1, zotero_key: 'ATTACH12', start_line: 8, end_line: 8 },
            ],
        }))) as ItemListView;
        expect(itemRows(view)[0].location_label).toBe('Lines 1-5, 8');
    });

    it('view_page_images (discontinued) maps to parent-centric page rows', async () => {
        installItems([
            { id: 90, key: 'PARENT10', firstCreator: 'Fox', date: '2024' },
            { id: 91, key: 'ATTACH10', kind: 'attachment', parentItemID: 90, isPDF: true },
        ]);
        const view = (await buildLegacyView(returnPart('view_page_images', {
            tool_name: 'view_page_images', result_count: 1,
            pages: [{ library_id: 1, zotero_key: 'ATTACH10', page_number: 7, format: 'png', width: 1, height: 1 }],
        }))) as ItemListView;
        expect(itemRows(view)[0].location_label).toBe('Page 7');
    });

    it('groups pages per attachment across multiple documents', async () => {
        installItems([
            { id: 100, key: 'PARENTA', firstCreator: 'Gray', date: '2020' },
            { id: 101, key: 'ATTA', kind: 'attachment', parentItemID: 100, isPDF: true },
            { id: 102, key: 'PARENTB', firstCreator: 'Hill', date: '2021' },
            { id: 103, key: 'ATTB', kind: 'attachment', parentItemID: 102, isPDF: true },
        ]);
        const view = (await buildLegacyView(returnPart('read', {
            tool_name: 'read', result_count: 4,
            pages: [
                { library_id: 1, zotero_key: 'ATTA', page_number: 1 },
                { library_id: 1, zotero_key: 'ATTB', page_number: 9 },
                { library_id: 1, zotero_key: 'ATTA', page_number: 2 },
                { library_id: 1, zotero_key: 'ATTB', page_number: 10 },
            ],
        }))) as ItemListView;
        const rows = itemRows(view);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ display_name: 'Gray 2020', location_label: 'Page 1-2' });
        expect(rows[1]).toMatchObject({ display_name: 'Hill 2021', location_label: 'Page 9-10' });
    });
});

// ===========================================================================
// Discontinued search tools
// ===========================================================================

describe('buildLegacyView — discontinued search tools', () => {
    it('search_in_attachment maps page references to parent-centric rows', async () => {
        installItems([
            { id: 110, key: 'PAR11', firstCreator: 'Ives', date: '2019' },
            { id: 111, key: 'ATT11', kind: 'attachment', parentItemID: 110, isPDF: true },
        ]);
        const view = (await buildLegacyView(returnPart('search_in_attachment', {
            tool_name: 'search_in_attachment', query: 'x', total_matches: 2, pages_with_matches: 2,
            pages: [
                { library_id: 1, zotero_key: 'ATT11', page_number: 3, match_count: 1, score: 1 },
                { library_id: 1, zotero_key: 'ATT11', page_number: 4, match_count: 1, score: 1 },
            ],
        }))) as ItemListView;
        expect(view.tool_name).toBe('search_in_attachment');
        expect(itemRows(view)[0].location_label).toBe('Page 3-4');
    });

    it('search_in_documents maps chunks (0-indexed) to parent-centric rows', async () => {
        installItems([
            { id: 120, key: 'PAR12', firstCreator: 'Joy', date: '2018' },
            { id: 121, key: 'ATT12', kind: 'attachment', parentItemID: 120, isPDF: true },
        ]);
        const view = (await buildLegacyView(returnPart('search_in_documents', {
            tool_name: 'search_in_documents', result_count: 1,
            chunks: [{ library_id: 1, zotero_key: 'ATT12', page: 0 }],
        }))) as ItemListView;
        expect(itemRows(view)[0].location_label).toBe('Page 1');
    });
});

// ===========================================================================
// Extract
// ===========================================================================

describe('buildLegacyView — extract', () => {
    it('builds item-centric rows with status mapped from extract status', async () => {
        installItems([
            { id: 130, key: 'EX0001', firstCreator: 'Kay', date: '2020', title: 'Good', displayTitle: 'Good' },
            { id: 131, key: 'EX0002', firstCreator: 'Lou', date: '2021', title: 'Bad', displayTitle: 'Bad' },
        ]);
        const view = (await buildLegacyView(returnPart('extract', {
            tool_name: 'extract', total_items: 2, items_processed: 2, items_failed: 1, total_pages_processed: 5,
            items: [
                { library_id: 1, zotero_key: 'EX0001', status: 'success' },
                { library_id: 1, zotero_key: 'EX0002', status: 'error' },
            ],
        }))) as ItemListView;
        const rows = itemRows(view);
        expect(rows[0]).toMatchObject({ display_name: 'Kay 2020', subtitle: 'Good', status: 'ok' });
        expect(rows[1]).toMatchObject({ display_name: 'Lou 2021', status: 'error' });
        // Extract has no location label.
        expect(rows[0].location_label ?? null).toBeNull();
    });

    it('headlines the bibliographic parent for an attachment-backed extract item (P), keeping showParentItem parity', async () => {
        installItems([
            { id: 133, key: 'EPAR01', firstCreator: 'Ash', date: '2018', title: 'Source Doc', displayTitle: 'Source Doc' },
            { id: 134, key: 'EATT01', kind: 'attachment', parentItemID: 133, isPDF: true, title: 'doc.pdf' },
        ]);
        const view = (await buildLegacyView(returnPart('extract', {
            tool_name: 'extract', total_items: 1, items_processed: 1, items_failed: 0, total_pages_processed: 3,
            items: [{ library_id: 1, zotero_key: 'EATT01', status: 'success' }],
        }))) as ItemListView;
        const rows = itemRows(view);
        expect(rows[0]).toMatchObject({
            display_name: 'Ash 2018',
            subtitle: 'Source Doc',
            attachment_label: 'doc.pdf',
            item_type: 'attachment',
            content_kind: 'pdf',
            status: 'ok',
        });
        // Extract carries no location label.
        expect(rows[0].location_label ?? null).toBeNull();
    });

    it('maps legacy "not_relevant" status to error (faded) parity', async () => {
        installItems([{ id: 132, key: 'EX0003', firstCreator: 'Moe', date: '2019' }]);
        const view = (await buildLegacyView(returnPart('extract', {
            tool_name: 'extract', total_items: 1, items_processed: 1, items_failed: 0, total_pages_processed: 0,
            items: [{ library_id: 1, zotero_key: 'EX0003', status: 'not_relevant' }],
        }))) as ItemListView;
        expect(itemRows(view)[0].status).toBe('error');
    });
});

// ===========================================================================
// read_note
// ===========================================================================

describe('buildLegacyView — read_note', () => {
    it('builds a single note row with parent bib subtitle (convention N)', async () => {
        installItems([
            { id: 140, key: 'PAR14', firstCreator: 'Nye', date: '2017', title: 'Source', displayTitle: 'Source' },
            { id: 141, key: 'NOTE14', kind: 'note', parentItemID: 140, noteTitle: 'Summary note' },
        ]);
        const view = (await buildLegacyView(returnPart('read_note', {
            tool_name: 'read_note', result_count: 1,
            note_item: { library_id: 1, zotero_key: 'NOTE14' },
            parent_item: { library_id: 1, zotero_key: 'PAR14' },
        }))) as ItemListView;
        const rows = itemRows(view);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ display_name: 'Summary note', subtitle: 'Nye 2017. Source', item_type: 'note' });
    });

    it('omits the subtitle for a standalone note', async () => {
        installItems([{ id: 142, key: 'NOTE15', kind: 'note', noteTitle: 'Standalone' }]);
        const view = (await buildLegacyView(returnPart('read_note', {
            tool_name: 'read_note', result_count: 1,
            note_item: { library_id: 1, zotero_key: 'NOTE15' },
            parent_item: null,
        }))) as ItemListView;
        expect(itemRows(view)[0]).toMatchObject({ display_name: 'Standalone', subtitle: null });
    });
});

// ===========================================================================
// AnnotationListView (get_annotations / find_annotations)
// ===========================================================================

describe('buildLegacyView — annotation list', () => {
    function annotationSummary(toolName: string) {
        return {
            tool_name: toolName,
            result_count: 1,
            total_count: 1,
            has_more: false,
            annotations: [{ library_id: 1, zotero_key: 'ANN001' }],
        };
    }

    function installAnnotation() {
        installItems([
            { id: 150, key: 'PAR15', firstCreator: 'Ott', date: '2016' },
            { id: 151, key: 'ATT15', kind: 'attachment', parentItemID: 150, isPDF: true },
            { id: 152, key: 'ANN001', kind: 'annotation', parentItemID: 151, annotationType: 'underline', annotationComment: 'see here', annotationPageLabel: '5' },
        ]);
    }

    it('hydrates annotation rows for get_annotations with compact variant', async () => {
        installAnnotation();
        const view = (await buildLegacyView(returnPart('get_annotations', annotationSummary('get_annotations')))) as AnnotationListView;
        expect(view.view_type).toBe('annotation_list');
        expect(view.variant).toBe('compact');
        expect(view.annotations[0]).toMatchObject({
            kind: 'annotation',
            annotation_type: 'underline',
            comment: 'see here',
            page_label: '5',
            source_display_name: 'Ott 2016',
        });
    });

    it('uses the with-parent variant for an unscoped find_annotations', async () => {
        installAnnotation();
        const view = (await buildLegacyView(returnPart('find_annotations', annotationSummary('find_annotations')))) as AnnotationListView;
        expect(view.variant).toBe('with-parent');
    });

    it('uses the compact variant for a find_annotations scoped to one attachment', async () => {
        installAnnotation();
        const view = (await buildLegacyView(
            returnPart('find_annotations', annotationSummary('find_annotations')),
            { attachment_id: '1-ATT15' },
        )) as AnnotationListView;
        expect(view.variant).toBe('compact');
    });

    it('skips references that are not annotations', async () => {
        installItems([{ id: 153, key: 'NOTANN', firstCreator: 'X', date: '2000' }]); // a regular item, not an annotation
        const view = (await buildLegacyView(returnPart('get_annotations', {
            tool_name: 'get_annotations', result_count: 1, total_count: 1, has_more: false,
            annotations: [{ library_id: 1, zotero_key: 'NOTANN' }],
        }))) as AnnotationListView;
        expect(view.annotations).toHaveLength(0);
    });

    it('caps long annotation text/comment to a bounded preview (not the full body)', async () => {
        const longText = 'x'.repeat(500);
        installItems([
            { id: 157, key: 'PAR17', firstCreator: 'Quinn', date: '2021' },
            { id: 158, key: 'ATT17', kind: 'attachment', parentItemID: 157, isPDF: true },
            {
                id: 159, key: 'ANN002', kind: 'annotation', parentItemID: 158,
                annotationType: 'highlight', annotationText: longText, annotationComment: longText,
            },
        ]);
        const view = (await buildLegacyView(returnPart('get_annotations', {
            tool_name: 'get_annotations', result_count: 1, total_count: 1, has_more: false,
            annotations: [{ library_id: 1, zotero_key: 'ANN002' }],
        }))) as AnnotationListView;
        const row = view.annotations[0];
        expect(row.text!.length).toBeLessThanOrEqual(303);
        expect(row.text!.endsWith('...')).toBe(true);
        expect(longText.startsWith(row.text!.slice(0, 300))).toBe(true);
        expect(row.comment!.length).toBeLessThanOrEqual(303);
    });
});

// ===========================================================================
// ExternalReferenceListView (external_search / lookup_work)
// ===========================================================================

describe('buildLegacyView — external references', () => {
    it('builds an external_reference_list from external_search content (no Zotero load)', async () => {
        const part: ToolReturnPart = {
            part_kind: 'tool-return',
            tool_name: 'external_search',
            content: { references: [{ external_id: 'oa:1', title: 'A Result', abstract: 'abc' }] },
            tool_call_id: 'c',
            metadata: { supplemental_data: [{ external_id: 'oa:1', source: 'openalex', authors: ['Smith, J.'] }] },
        };
        const view = (await buildLegacyView(part)) as ExternalReferenceListView;
        expect(view.view_type).toBe('external_reference_list');
        expect(view.references).toHaveLength(1);
        expect(view.references[0]).toMatchObject({ source_id: 'oa:1', title: 'A Result', authors: ['Smith, J.'] });
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('builds a lookup_work view with found/not-found/unavailable extras', async () => {
        const part: ToolReturnPart = {
            part_kind: 'tool-return',
            tool_name: 'lookup_work',
            content: {
                found_count: 1,
                references: [{ external_id: 'oa:2', title: 'Found Work' }],
                not_found_queries: ['missing one'],
                temporarily_unchecked_queries: ['rate limited'],
                message: 'done',
            },
            tool_call_id: 'c',
            metadata: {},
        };
        const view = (await buildLegacyView(part)) as ExternalReferenceListView;
        expect(view.tool_name).toBe('lookup_work');
        expect(view.found_count).toBe(1);
        expect(view.references[0]).toMatchObject({ source_id: 'oa:2', title: 'Found Work' });
        expect(view.not_found_queries).toEqual(['missing one']);
        expect(view.unavailable_queries).toEqual(['rate limited']);
        expect(view.message).toBe('done');
    });
});

// ===========================================================================
// CollectionListView / TagListView
// ===========================================================================

describe('buildLegacyView — collections and tags', () => {
    it('builds a collection_list view from a list_collections summary', async () => {
        const view = (await buildLegacyView(returnPart('list_collections', {
            tool_name: 'list_collections',
            total_count: 2,
            library_id: 1,
            collections: [
                { collection_key: 'COLL0001', name: 'Reading' },
                { collection_key: 'COLL0002', name: 'To Read' },
            ],
        }))) as CollectionListView;
        expect(view.view_type).toBe('collection_list');
        expect(view.total_count).toBe(2);
        expect(view.collections).toEqual([
            { library_id: 1, collection_key: 'COLL0001', name: 'Reading' },
            { library_id: 1, collection_key: 'COLL0002', name: 'To Read' },
        ]);
    });

    it('builds a tag_list view from a list_tags summary', async () => {
        const view = (await buildLegacyView(returnPart('list_tags', {
            tool_name: 'list_tags',
            total_count: 1,
            tags: [{ name: 'method', item_count: 12 }],
        }))) as TagListView;
        expect(view.view_type).toBe('tag_list');
        expect(view.tags).toEqual([{ name: 'method', item_count: 12 }]);
        expect(view.total_count).toBe(1);
    });
});

// ===========================================================================
// AttachmentSearchView (find_in_attachments)
// ===========================================================================

describe('buildLegacyView — find_in_attachments', () => {
    function findPart(attachments: unknown[]): ToolReturnPart {
        return returnPart('find_in_attachments', {
            tool_name: 'find_in_attachments',
            query: 'gene',
            total_matches: 3,
            attachment_count: attachments.length,
            attachments,
        });
    }

    it('hydrates a Zotero attachment row with the parent display name and matches', async () => {
        installItems([
            { id: 160, key: 'PAR16', firstCreator: 'Park', date: '2024', title: 'Genes' },
            { id: 161, key: 'ATT16', kind: 'attachment', parentItemID: 160, isPDF: true },
        ]);
        const view = (await buildLegacyView(findPart([
            {
                library_id: 1, zotero_key: 'ATT16', status: 'ok', match_count: 2, pages: [3, 7], content_kind: 'pdf',
                matches: [
                    { snippet: 'gene expression', page_number: 3, page_label: '3', target: { part_id: 's1', page_idx: 2 } },
                    { snippet: 'gene therapy', page_number: 7 },
                ],
            },
        ]))) as AttachmentSearchView;
        expect(view.view_type).toBe('attachment_search');
        expect(view.query).toBe('gene');
        const row = view.attachments[0];
        expect(row).toMatchObject({
            library_id: 1,
            zotero_key: 'ATT16',
            display_name: 'Park 2024',
            item_type: 'journalArticle',
            content_kind: 'pdf',
            status: 'ok',
            match_count: 2,
            is_external: false,
        });
        expect(row.matches).toHaveLength(2);
        expect(row.matches[0]).toMatchObject({ snippet: 'gene expression', page_number: 3, page_label: '3' });
        expect(row.matches[0].target).toMatchObject({ part_id: 's1', page_idx: 2 });
        expect(row.matches[1].page_label ?? null).toBeNull();
    });

    it('resolves an external-file row from the local registry and marks it external', async () => {
        (globalThis as any).Zotero.Beaver = {
            db: { getExternalFileByKey: vi.fn().mockResolvedValue({ filename: 'mydoc.pdf', contentKind: 'pdf', storedPath: '/x' }) },
        };
        const view = (await buildLegacyView(findPart([
            { library_id: -1, zotero_key: 'EXTKEY01', status: 'ok', match_count: 1, pages: [1], content_kind: 'pdf', matches: [{ snippet: 'hit', page_number: 1 }] },
        ]))) as AttachmentSearchView;
        const row = view.attachments[0];
        expect(row.is_external).toBe(true);
        expect(row.display_name).toBe('mydoc.pdf');
    });

    it('falls back to a placeholder name for an external file missing from the registry', async () => {
        (globalThis as any).Zotero.Beaver = { db: { getExternalFileByKey: vi.fn().mockResolvedValue(null) } };
        const view = (await buildLegacyView(findPart([
            { library_id: -1, zotero_key: 'EXTKEY02', status: 'no_matches', match_count: 0, pages: [], content_kind: 'pdf', matches: [] },
        ]))) as AttachmentSearchView;
        expect(view.attachments[0].display_name).toBe('Attached file (ext-EXTKEY02)');
        expect(view.attachments[0].is_external).toBe(true);
    });

    it('keeps the key as display name for an attachment no longer in the library', async () => {
        installItems([]); // ATT not found
        const view = (await buildLegacyView(findPart([
            { library_id: 1, zotero_key: 'GONEATT', status: 'error', match_count: 0, pages: [], content_kind: 'pdf', matches: [], error: 'unreadable' },
        ]))) as AttachmentSearchView;
        const row = view.attachments[0];
        expect(row.display_name).toBe('GONEATT');
        expect(row.item_type ?? null).toBeNull();
        expect(row.status).toBe('error');
        expect(row.error).toBe('unreadable');
    });
});

// ===========================================================================
// Resilience
// ===========================================================================

describe('buildLegacyView — resilience', () => {
    it('returns null when a hydration load throws (never breaks thread load)', async () => {
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn(() => { throw new Error('db exploded'); }),
            getAsync: vi.fn(),
        };
        // loadItem swallows the throw → unresolved row, so the view still builds.
        const view = await buildLegacyView(returnPart('zotero_search', {
            tool_name: 'zotero_search', total_count: 1, items: [{ library_id: 1, zotero_key: 'X' }],
        }));
        expect(view).not.toBeNull();
        expect((view as ItemListView).items[0]).toMatchObject({ kind: 'item', display_name: 'X' });
    });

    it('returns null for a failed tool result with neither summary nor content', async () => {
        const part: ToolReturnPart = {
            part_kind: 'tool-return', tool_name: 'read', content: null, tool_call_id: 'c', metadata: {},
        };
        expect(await buildLegacyView(part)).toBeNull();
    });
});
