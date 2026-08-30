/**
 * Dev-only HTTP handlers for looking at the table renderer.
 *
 * `/beaver/test/open-table` puts a `TableSpec` on `windowSurfaceAtom` and opens
 * the separate Beaver window at a width a table can actually use. Nothing in
 * the product routes to that surface yet — this is how it gets driven until
 * something does.
 *
 * Given no spec, it builds one from real items in the user's library, so the
 * host-backed row verbs (reveal, open) act on items that exist rather than on
 * fabricated keys. The demo covers every `ColumnType` and every cell state
 * deliberately: an empty value, a pending cell under a filling column, a failed
 * cell, a hand-edited one and a failed row.
 *
 * `/beaver/test/table-create`, `-read` and `-list` drive the stored side: the
 * same spec written to the library as a snapshot attachment, read back out of
 * the file, and enumerated. `-write`, `-edit`, `-versions`, `-revert`,
 * `-delete` and `-open` drive the versioned store on top of it, and `-corrupt`
 * damages a table's storage directory on purpose so crash recovery can be
 * exercised without staging a real crash.
 *
 * `-open-reader` and `-view-state` drive the reader host: the first opens a
 * stored table in Zotero's reader and reports which of the enhancer's seams
 * attached, the second lists what is currently enhanced in either host.
 */

import type {
    Cell,
    Column,
    Row,
    TableSpec,
} from '@beaver/agent-core/layouts/table';
import { rowIdFor, validateTableSpec } from '@beaver/agent-core/layouts/table';
import { store } from '../../store';
import { windowSurfaceAtom, type WindowSurface } from '../../atoms/windowSurface';
import { BeaverUIFactory } from '../../../src/ui/ui';
import {
    closeTableTab,
    listTableTabViews,
    openTableTab,
    zoteroLinksFor,
} from '../../../src/ui/tableTab';
import {
    listReaderTableViews,
    openTableInReader,
} from '../../../src/services/artifacts/view/readerTableView';
import { getSearchableLibraryIds } from '../../../src/services/agentDataProvider/utils';
import { libraryRefForLibraryID } from '../../../src/utils/libraryIdentity';
import { safeAttachmentFilename } from '../../../src/utils/attachmentFiles';
import { buildTableDocument } from '../../../src/services/artifacts/tableDocument';
import {
    isTableItem,
    loadTableItemFields,
    readTableItemSpec,
    tableHistoryPath,
    tableSidecarDirectory,
    tableStorageDirectory,
    tableVersionPath,
    TABLE_TAG,
    TableItemError,
} from '../../../src/services/artifacts/tableItem';
import {
    createTable,
    deleteTable,
    editTable,
    listVersions,
    openTable,
    readTable,
    restoreTable,
    revertTable,
    writeTable,
    type TableRef,
    type TableWriteMeta,
} from '../../../src/services/artifacts/tableStore';
import type { TableMutation } from '@beaver/agent-core/layouts/tableMutations';

/** Wide enough for the demo's columns; the window grows to it and no further. */
const TABLE_WINDOW_SIZE = { width: 1180, height: 780 };

const DEMO_ROW_LIMIT = 8;

interface OpenTableRequest {
    variant?: 'search' | 'extraction';
    /** A spec to render as-is. Omit it and one is built from the library. */
    table?: TableSpec;
    title?: string;
    subtitle?: string;
    /** How many library items the built spec should cover. */
    limit?: number;
    /** Pass false to leave the window closed and only set the surface. */
    open?: boolean;
}

export async function handleTestOpenTableHttpRequest(
    request: OpenTableRequest = {}
): Promise<any> {
    const variant = request.variant === 'extraction' ? 'extraction' : 'search';
    const table =
        request.table ??
        (await buildDemoTable(variant, request.limit ?? DEMO_ROW_LIMIT));

    const surface: WindowSurface = {
        kind: 'table',
        variant,
        table,
        title: request.title,
        subtitle: request.subtitle,
    };
    store.set(windowSurfaceAtom, surface);

    if (request.open !== false) {
        BeaverUIFactory.openBeaverWindow(TABLE_WINDOW_SIZE);
    }

    return {
        ok: true,
        variant,
        table_id: table.id,
        columns: table.columns.map((c) => c.id),
        rows: table.rows.length,
        window_open: !!BeaverUIFactory.findBeaverWindow(),
    };
}

interface OpenTableTabRequest extends OpenTableRequest {
    /** Reuse (and re-render) this tab instead of adding another. */
    tab_id?: string;
}

/**
 * The same spec, in a Zotero tab rather than the window — the static HTML
 * rendering, which is what a saved snapshot would hold.
 */
export async function handleTestOpenTableTabHttpRequest(
    request: OpenTableTabRequest = {}
): Promise<any> {
    const variant = request.variant === 'extraction' ? 'extraction' : 'search';
    const table =
        request.table ??
        (await buildDemoTable(variant, request.limit ?? DEMO_ROW_LIMIT));

    const tabId = openTableTab(table, {
        title: request.title ?? (variant === 'extraction' ? 'Extraction' : 'Search results'),
        tabId: request.tab_id,
    });

    return {
        ok: !!tabId,
        tab_id: tabId,
        variant,
        rows: table.rows.length,
        columns: table.columns.map((c) => c.id),
    };
}

export async function handleTestCloseTableTabHttpRequest(
    request: { tab_id?: string } = {}
): Promise<any> {
    if (request.tab_id) closeTableTab(request.tab_id);
    return { ok: true };
}

/** Hands the window back to the thread. */
export async function handleTestCloseTableHttpRequest(): Promise<any> {
    store.set(windowSurfaceAtom, { kind: 'thread' });
    return { ok: true, window_open: !!BeaverUIFactory.findBeaverWindow() };
}

// ---------------------------------------------------------------------------
// Demo spec
// ---------------------------------------------------------------------------

interface DemoItem {
    libraryID: number;
    key: string;
    libraryRef?: string;
    title: string;
    creators: string;
    year: string;
    venue: string;
    itemType: string;
    abstract: string;
    doi: string;
    hasPdf: boolean;
}

async function collectDemoItems(limit: number): Promise<DemoItem[]> {
    const libraryIds = getSearchableLibraryIds();
    if (libraryIds.length === 0) return [];

    const items: Zotero.Item[] = [];
    for (const libraryID of libraryIds) {
        const all = await Zotero.Items.getAll(libraryID, true);
        for (const item of all) {
            if (!item.isRegularItem()) continue;
            items.push(item);
            if (items.length >= limit) break;
        }
        if (items.length >= limit) break;
    }
    if (items.length === 0) return [];

    await Zotero.Items.loadDataTypes(items, ['itemData', 'creators', 'childItems']);

    return items.map((item) => {
        const creators = item
            .getCreators()
            .slice(0, 3)
            .map((c: any) => c.lastName || c.name)
            .filter(Boolean);
        const attachments = item.getAttachments() as number[];
        const hasPdf = attachments.some((id) => {
            const attachment = Zotero.Items.get(id);
            return attachment?.attachmentContentType === 'application/pdf';
        });
        return {
            libraryID: item.libraryID,
            key: item.key,
            libraryRef: libraryRefForLibraryID(item.libraryID) ?? undefined,
            title: item.getField('title') || '(no title)',
            creators: creators.join(', ') || 'Unknown',
            year: yearOf(item),
            venue:
                item.getField('publicationTitle') ||
                item.getField('publisher') ||
                '',
            itemType: item.itemType,
            abstract: item.getField('abstractNote') || '',
            doi: item.getField('DOI') || '',
            hasPdf,
        };
    });
}

/** A Zotero `date` field is free-form, so read the year through Zotero's parser. */
function yearOf(item: Zotero.Item): string {
    const raw = item.getField('date');
    if (!raw) return '';
    const parsed = Zotero.Date.strToDate(raw) as { year?: number };
    return parsed?.year ? String(parsed.year) : '';
}

/** The inline tag a cell carries, and the `raw_tag` its citation answers to. */
function citationTag(item: DemoItem, index: number): string {
    return `<citation id="${item.libraryID}-${item.key}" loc="page${index + 1}"/>`;
}

/** One sentence of an abstract, as a stand-in for an extracted field. */
function sentence(text: string, index: number): string {
    const parts = text.split(/(?<=\.)\s+/).filter((p) => p.trim().length > 20);
    const picked = parts[index % Math.max(1, parts.length)] ?? text;
    return picked.length > 150 ? `${picked.slice(0, 147)}…` : picked;
}

/**
 * A demo cell. Every value carries `provenance`, because a spec whose cells
 * have values and no provenance is invalid — an unattributed value is not
 * evidence. `asserted` is the honest label for hand-built demo data: nothing
 * read a document for it.
 */
function textCell(text: string): Cell {
    return text ? { value: { kind: 'text', text }, provenance: 'asserted' } : {};
}

async function buildDemoTable(
    variant: 'search' | 'extraction',
    limit: number
): Promise<TableSpec> {
    const items = await collectDemoItems(limit);
    return variant === 'extraction'
        ? buildExtractionDemo(items)
        : buildSearchDemo(items);
}

function referenceRow(item: DemoItem, index: number, withAbstract = true): Row {
    const ref = {
        kind: 'item' as const,
        library_id: item.libraryID,
        zotero_key: item.key,
        library_ref: item.libraryRef,
    };
    return {
        id: rowIdFor(ref),
        ref,
        cells: {
            ref: {
                value: {
                    kind: 'reference',
                    display_name: item.title,
                    subtitle: item.creators,
                    venue: item.venue || undefined,
                    item_type: item.itemType,
                },
                provenance: 'asserted',
                details:
                    withAbstract && item.abstract
                        ? { kind: 'text', label: 'Abstract', text: item.abstract }
                        : undefined,
            },
        },
    };
}

function buildSearchDemo(items: DemoItem[]): TableSpec {
    const columns: Column[] = [
        { id: 'ref', header: 'Item', type: 'reference', priority: 'primary' },
        { id: 'year', header: 'Year', type: 'date', priority: 'primary' },
        { id: 'cites', header: 'Citations', type: 'number', priority: 'primary' },
        {
            id: 'type',
            header: 'Type',
            type: 'select',
            options: [
                { label: 'Journal article', color: 'blue' },
                { label: 'Book', color: 'purple' },
                { label: 'Preprint', color: 'orange' },
                { label: 'Other', color: 'gray' },
            ],
        },
        { id: 'oa', header: 'OA', type: 'boolean' },
        { id: 'abstract', header: 'Abstract', type: 'text' },
        { id: 'doi', header: 'DOI', type: 'link' },
    ];

    const rows: Row[] = items.map((item, i) => {
        // No abstract on the reference cell: this table has a column for it,
        // and carrying both prints it twice in the expanded row.
        const row = referenceRow(item, i, false);
        row.cells.year = item.year
            ? { value: { kind: 'date', value: item.year }, provenance: 'asserted' }
            : {};
        // Stand-in metrics: the demo is about the rendering, not the numbers.
        row.cells.cites = {
            value: { kind: 'number', value: (i + 1) * 137 },
            provenance: 'asserted',
        };
        row.cells.type = {
            value: { kind: 'select', label: selectLabelFor(item.itemType) },
            provenance: 'asserted',
        };
        row.cells.oa = {
            value: { kind: 'boolean', value: i % 3 !== 0 },
            provenance: 'asserted',
        };
        row.cells.abstract = textCell(item.abstract);
        row.cells.doi = item.doi
            ? {
                  value: {
                      kind: 'link',
                      url: `https://doi.org/${item.doi}`,
                      label: item.doi,
                  },
                  provenance: 'asserted',
              }
            : {};
        return row;
    });

    // One row that could not be resolved, so the failed-row treatment is visible.
    rows.push({
        id: 'ext:openalex:demo-failed',
        ref: { kind: 'external', source: 'openalex', source_id: 'demo-failed' },
        status: 'error',
        error: 'Metadata could not be retrieved from the source',
        cells: {
            ref: {
                value: {
                    kind: 'reference',
                    display_name: 'A result whose metadata failed to load',
                    subtitle: 'openalex',
                    venue: 'demo-failed',
                },
                provenance: 'asserted',
            },
            abstract: { status: 'error', error: 'No abstract available' },
        },
    });

    return {
        id: 'demo-search',
        title: 'External search — demo',
        caption: 'Built from your library. Citation counts and OA flags are stand-ins.',
        anchor_column_id: 'ref',
        columns,
        rows,
        sort: { column_id: 'cites', direction: 'desc' },
        capabilities: { row_actions: ['reveal', 'import'] },
    };
}

function buildExtractionDemo(items: DemoItem[]): TableSpec {
    const columns: Column[] = [
        { id: 'ref', header: 'Item', type: 'reference', priority: 'primary' },
        { id: 'year', header: 'Year', type: 'date', priority: 'primary' },
        {
            id: 'sample',
            header: 'Sample & setting',
            type: 'text',
            description: 'What was the sample and the setting? Report N and the population studied.',
            details: {
                kind: 'list',
                items: [
                    'Report the analytic N, not the recruited N.',
                    'Name the country and the years covered.',
                ],
            },
        },
        {
            id: 'design',
            header: 'Design',
            type: 'select',
            description: 'Is this an RCT, a quasi-experiment or observational?',
            options: [
                { label: 'RCT', color: 'green' },
                { label: 'Quasi-experiment', color: 'blue' },
                { label: 'Observational', color: 'purple' },
                { label: 'Unclear', color: 'gray' },
            ],
        },
        {
            id: 'effect',
            header: 'Headline effect',
            type: 'text',
            description: 'The headline effect, with direction and magnitude.',
        },
        {
            id: 'retention',
            header: 'Attrition & retention',
            type: 'text',
            description: 'Any reported effect on quitting, attrition or retention.',
            status: 'filling',
            progress: { done: Math.min(3, items.length), total: items.length || 1 },
        },
    ];

    const designs = ['RCT', 'Quasi-experiment', 'Observational', 'Unclear'];

    const rows: Row[] = items.map((item, i) => {
        const row = referenceRow(item, i);
        row.cells.year = item.year
            ? { value: { kind: 'date', value: item.year }, provenance: 'asserted' }
            : {};
        // A citation tag per cell, so the marker, its tooltip and the source
        // list all have something real to resolve against.
        const cite = citationTag(item, i);
        // Short, the way a real extracted field is: the citation marker rides
        // at the end of the claim, and a paragraph long enough to be clamped
        // would hide it.
        row.cells.sample = {
            ...textCell(
                item.abstract ? `${sentence(item.abstract, 0)} ${cite}` : ''
            ),
            // One hand-edited cell, so a second provenance shows up.
            provenance: i === 1 ? 'user' : 'asserted',
        };
        row.cells.design = {
            value: { kind: 'select', label: designs[i % designs.length] },
            provenance: 'asserted',
        };
        // A cell the producer reports nothing for is a finding, not a gap.
        row.cells.effect =
            i === 2
                ? {}
                : i === 3
                  ? { status: 'error', error: 'The PDF has no extractable text layer' }
                  : textCell(`${sentence(item.abstract, 1)} ${cite}`);
        // The filling column: the first few are done, the rest are pending.
        row.cells.retention =
            i < 3
                ? textCell(`${sentence(item.abstract, 2)} ${cite}`)
                : { status: 'pending' };
        return row;
    });

    return {
        id: 'demo-extraction',
        title: 'Extraction — demo',
        caption: 'Built from your library. Cell contents are excerpts, not real extractions.',
        anchor_column_id: 'ref',
        columns,
        rows,
        capabilities: {
            row_actions: ['reveal'],
            allow_add_column: true,
            allow_add_row: true,
        },
        cost_estimate: { per_row_credits: 1, estimated_seconds: 40 },
        citations: items.map((item, i) => ({
            citation_id: `${item.key}-${i}`,
            // The tag exactly as the cells carry it, so the key the renderer
            // derives from the text is one this citation answers to.
            raw_tag: citationTag(item, i),
            requested_ref: {
                kind: 'zotero' as const,
                library_id: item.libraryID,
                zotero_key: item.key,
                loc: {
                    kind: 'page' as const,
                    value: String(i + 1),
                    raw: `page${i + 1}`,
                },
            },
            resolved_ref: {
                kind: 'zotero' as const,
                library_id: item.libraryID,
                zotero_key: item.key,
            },
            citation_type: 'attachment' as const,
            display_name: `${item.creators.split(',')[0]} ${item.year}`.trim(),
            formatted_citation: [item.creators, item.year, item.title, item.venue]
                .filter(Boolean)
                .join('. '),
            preview: item.abstract.slice(0, 180),
            pages: [i + 1],
        })),
    };
}

function selectLabelFor(itemType: string): string {
    if (itemType === 'journalArticle') return 'Journal article';
    if (itemType === 'book' || itemType === 'bookSection') return 'Book';
    if (itemType === 'preprint') return 'Preprint';
    return 'Other';
}

// ---------------------------------------------------------------------------
// Stored tables (dev-only)
// ---------------------------------------------------------------------------

/**
 * The library-item side of a table: create one, read the spec back out of the
 * stored file, and list what is in the library. These drive the real
 * `Zotero.Attachments` path, so a created table is a genuine snapshot
 * attachment that opens in the reader. Creation goes through
 * `tableStore.createTable`, which is what starts the version log.
 *
 * Failures answer 200 with `ok: false` and the error's `code`, so a caller sees
 * *why* a write was refused (an excluded library, a group library) instead of a
 * bare 500.
 */

interface TableCreateRequest extends OpenTableRequest {
    /** The spec to store. Omit it and a demo spec is built from the library. */
    spec?: TableSpec;
    libraryID?: number;
    collectionID?: number;
    actor?: string;
    run_id?: string;
    thread_id?: string;
    change?: string;
}

export async function handleTestTableCreateHttpRequest(
    request: TableCreateRequest = {}
): Promise<any> {
    const variant = request.variant === 'extraction' ? 'extraction' : 'search';
    const spec =
        request.spec ??
        request.table ??
        (await buildDemoTable(variant, request.limit ?? DEMO_ROW_LIMIT));

    try {
        // Through the store, never `createTableItem` directly: creation is what
        // seeds `beaver/v1.json` and the log entry that makes version 1
        // revertable.
        const created = await createTable({
            spec,
            title: request.title,
            libraryID: request.libraryID,
            collectionID: request.collectionID,
            ...writeMetaFrom(request),
        });
        return {
            ok: true,
            key: created.key,
            item_id: created.itemID,
            library_id: created.libraryID,
            title: created.title,
            filename: created.filename,
            storage_directory: created.storageDirectory,
            byte_length: created.byteLength,
            css_rule_count: created.cssRuleCount,
            spec_version: created.spec.spec_version,
            version: created.version,
            entry: created.entry,
            rows: created.spec.rows.length,
            columns: created.spec.columns.map((c) => c.id),
            // A created demo table should carry no issues; anything here means
            // the spec that was stored is not one a producer should emit.
            spec_issues: validateTableSpec(created.spec),
            select_uri: created.selectUri,
            open_uri: created.openUri,
        };
    } catch (error) {
        return errorResponse(error);
    }
}

interface TableReadRequest {
    libraryID?: number;
    key?: string;
}

export async function handleTestTableReadHttpRequest(
    request: TableReadRequest = {}
): Promise<any> {
    if (!request.key) return { ok: false, code: 'invalid_request', error: 'key is required' };
    const libraryID = request.libraryID ?? Zotero.Libraries.userLibraryID;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, request.key) as
        | Zotero.Item
        | false;
    if (!item) {
        return {
            ok: false,
            code: 'not_found',
            error: `No item ${request.key} in library ${libraryID}`,
        };
    }

    await loadTableItemFields([item]);
    const isTable = isTableItem(item);
    const read = await readTableItemSpec(item);
    if (!read.ok) {
        return {
            ok: false,
            is_table_item: isTable,
            code: read.code,
            error: read.message,
            spec_version: read.specVersion,
        };
    }
    return {
        ok: true,
        is_table_item: isTable,
        key: item.key,
        library_id: item.libraryID,
        storage_directory: tableStorageDirectory(item),
        // 0 is `to_upload`: a write that failed to set it leaves the new bytes
        // sitting locally with nothing to say they changed.
        sync_state: item.attachmentSyncState,
        version: read.spec.version,
        spec: read.spec,
        spec_issues: validateTableSpec(read.spec),
    };
}

/**
 * Every stored table, across every local library.
 *
 * Not filtered by library exclusion: these are the user's own artifacts and the
 * listing never leaves the machine — exclusion governs what Beaver sends out
 * and writes, not what the user may look at. Excluded libraries are flagged
 * rather than hidden.
 */
export async function handleTestTableListHttpRequest(): Promise<any> {
    const searchable = new Set(getSearchableLibraryIds());
    const tables: any[] = [];

    for (const library of Zotero.Libraries.getAll()) {
        const search = new Zotero.Search() as unknown as ZoteroSearchWritable;
        search.libraryID = library.libraryID;
        search.addCondition('tag', 'is', TABLE_TAG);
        // Trashed tables are listed too, so a trash/restore round trip is
        // visible here rather than looking like the table disappeared.
        search.addCondition('includeDeleted', 'true', '');
        const itemIDs = await search.search();
        if (!itemIDs?.length) continue;

        const items = (await Zotero.Items.getAsync(itemIDs)) as Zotero.Item[];
        await loadTableItemFields(items);
        for (const item of items) {
            if (!isTableItem(item)) continue;
            const read = await readTableItemSpec(item);
            tables.push({
                key: item.key,
                library_id: item.libraryID,
                library_name: library.name,
                library_excluded: !searchable.has(library.libraryID),
                title: item.getField('title'),
                filename: safeAttachmentFilename(item),
                deleted: !!item.deleted,
                rows: read.ok ? read.spec.rows.length : null,
                columns: read.ok ? read.spec.columns.length : null,
                version: read.ok ? read.spec.version : null,
                error: read.ok ? undefined : `${read.code}: ${read.message}`,
            });
        }
    }

    return { ok: true, count: tables.length, tables };
}

function errorResponse(error: unknown): any {
    const code = error instanceof TableItemError ? error.code : 'unexpected_error';
    return {
        ok: false,
        code,
        error: error instanceof Error ? error.message : String(error),
    };
}

// ---------------------------------------------------------------------------
// The versioned store (dev-only)
// ---------------------------------------------------------------------------

/**
 * The write side of a stored table: every revision, the version log, revert,
 * trash/restore, and the crash recovery `open` performs.
 *
 * These call `tableStore` and nothing else, so what they exercise is exactly
 * the write protocol the product uses — the single-flight lock, the version
 * guard, the retention cap. Failures answer 200 with `ok: false` and the
 * error's `code`, so a caller sees *why* rather than a bare 500.
 */

interface TableStoreRequest {
    key?: string;
    libraryID?: number;
    actor?: string;
    run_id?: string;
    thread_id?: string;
    change?: string;
}

function tableRefFrom(request: TableStoreRequest): TableRef | null {
    if (!request.key) return null;
    return {
        libraryID: request.libraryID ?? Zotero.Libraries.userLibraryID,
        key: request.key,
    };
}

function writeMetaFrom(request: TableStoreRequest): TableWriteMeta {
    const actor =
        request.actor === 'user' || request.actor === 'system' ? request.actor : 'agent';
    return {
        actor,
        run_id: request.run_id,
        thread_id: request.thread_id,
        change: request.change,
    };
}

const MISSING_KEY = { ok: false, code: 'invalid_request', error: 'key is required' };

/** One response shape for every path that ends in a store write. */
function writeResponse(
    result: Awaited<ReturnType<typeof writeTable>>
): Record<string, unknown> {
    if (!result.ok) {
        return {
            ok: false,
            code: 'conflict',
            conflict: true,
            error: `The table is at version ${result.version}.`,
            version: result.version,
            spec: result.spec,
        };
    }
    return {
        ok: true,
        version: result.version,
        // False here after a second write in the same run means the collapse
        // rule did not fire when it should have.
        collapsed: result.collapsed,
        // False means the table landed but Zotero's own bookkeeping did not.
        saved: result.saved,
        pruned: result.pruned,
        entry: result.entry,
        rows: result.spec.rows.length,
        columns: result.spec.columns.map((c) => c.id),
        spec_version: result.spec.spec_version,
        spec_issues: validateTableSpec(result.spec),
    };
}

interface TableWriteRequest extends TableStoreRequest {
    spec?: TableSpec;
    expectedVersion?: number;
}

export async function handleTestTableWriteHttpRequest(
    request: TableWriteRequest = {}
): Promise<any> {
    const ref = tableRefFrom(request);
    if (!ref) return MISSING_KEY;
    if (!request.spec) {
        return { ok: false, code: 'invalid_request', error: 'spec is required' };
    }
    try {
        return writeResponse(
            await writeTable(
                ref,
                request.spec,
                writeMetaFrom(request),
                request.expectedVersion
            )
        );
    } catch (error) {
        return errorResponse(error);
    }
}

interface TableEditRequest extends TableStoreRequest {
    mutations?: TableMutation[];
}

export async function handleTestTableEditHttpRequest(
    request: TableEditRequest = {}
): Promise<any> {
    const ref = tableRefFrom(request);
    if (!ref) return MISSING_KEY;
    if (!Array.isArray(request.mutations)) {
        return { ok: false, code: 'invalid_request', error: 'mutations is required' };
    }
    try {
        const result = await editTable(ref, request.mutations, writeMetaFrom(request));
        // A rejected mutation is not a conflict: the caller asked for something
        // the table cannot do, and the apply error says which part.
        if (!result.ok && 'error' in result) {
            return { ok: false, code: result.error.code, error: result.error.message };
        }
        return writeResponse(result);
    } catch (error) {
        return errorResponse(error);
    }
}

export async function handleTestTableVersionsHttpRequest(
    request: TableStoreRequest = {}
): Promise<any> {
    const ref = tableRefFrom(request);
    if (!ref) return MISSING_KEY;
    try {
        const versions = await listVersions(ref);
        const current = await readTable(ref);
        return {
            ok: true,
            version: current.version,
            count: versions.length,
            versions,
        };
    } catch (error) {
        return errorResponse(error);
    }
}

interface TableRevertRequest extends TableStoreRequest {
    toVersion?: number;
}

export async function handleTestTableRevertHttpRequest(
    request: TableRevertRequest = {}
): Promise<any> {
    const ref = tableRefFrom(request);
    if (!ref) return MISSING_KEY;
    if (typeof request.toVersion !== 'number') {
        return { ok: false, code: 'invalid_request', error: 'toVersion is required' };
    }
    try {
        return writeResponse(
            await revertTable(ref, request.toVersion, writeMetaFrom(request))
        );
    } catch (error) {
        return errorResponse(error);
    }
}

interface TableDeleteRequest extends TableStoreRequest {
    /** Take it back out of the trash instead of putting it in. */
    restore?: boolean;
}

export async function handleTestTableDeleteHttpRequest(
    request: TableDeleteRequest = {}
): Promise<any> {
    const ref = tableRefFrom(request);
    if (!ref) return MISSING_KEY;
    try {
        if (request.restore) {
            await restoreTable(ref);
            return { ok: true, deleted: false };
        }
        await deleteTable(ref);
        return { ok: true, deleted: true };
    } catch (error) {
        return errorResponse(error);
    }
}

export async function handleTestTableOpenHttpRequest(
    request: TableStoreRequest = {}
): Promise<any> {
    const ref = tableRefFrom(request);
    if (!ref) return MISSING_KEY;
    try {
        const opened = await openTable(ref);
        return {
            ok: true,
            key: ref.key,
            library_id: ref.libraryID,
            version: opened.version,
            // Empty on a table nothing interrupted; the shapes are documented
            // on `TableRecovery`.
            recovered: opened.recovered,
            history: opened.history,
            rows: opened.spec.rows.length,
            columns: opened.spec.columns.map((c) => c.id),
            spec: opened.spec,
            spec_issues: validateTableSpec(opened.spec),
        };
    } catch (error) {
        return errorResponse(error);
    }
}

interface TableCorruptRequest {
    key?: string;
    libraryID?: number;
    mode?: 'drop_history' | 'orphan_version' | 'html_ahead';
}

/**
 * Damages a table's storage directory on purpose, so `table-open`'s recovery
 * can be driven from outside without staging a real crash.
 *
 * This is the one place that writes a table file without going through the
 * store, which is exactly the point — it reproduces the states an interrupted
 * write leaves behind:
 *
 * - `drop_history` — the log is gone.
 * - `orphan_version` — a `v<N>.json` no entry and no HTML refers to, as if the
 *   write stopped after step 4.
 * - `html_ahead` — the document committed a version the log never recorded, as
 *   if the write stopped after step 5.
 *
 * Guarded to a `beaver-table` item: nothing else is ever touched.
 */
export async function handleTestTableCorruptHttpRequest(
    request: TableCorruptRequest = {}
): Promise<any> {
    if (!request.key) return MISSING_KEY;
    const mode = request.mode ?? 'drop_history';
    const libraryID = request.libraryID ?? Zotero.Libraries.userLibraryID;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, request.key) as
        | Zotero.Item
        | false;
    if (!item) {
        return {
            ok: false,
            code: 'not_found',
            error: `No item ${request.key} in library ${libraryID}`,
        };
    }
    await loadTableItemFields([item]);
    if (!isTableItem(item)) {
        return {
            ok: false,
            code: 'not_a_table',
            error: `Item ${request.key} is not a Beaver table — refusing to damage it.`,
        };
    }

    const read = await readTableItemSpec(item);
    if (!read.ok) {
        return { ok: false, code: read.code, error: read.message };
    }

    const historyPath = tableHistoryPath(item);
    const sidecar = tableSidecarDirectory(item);
    if (!historyPath || !sidecar) {
        return {
            ok: false,
            code: 'file_missing',
            error: `Table ${request.key} has no storage directory.`,
        };
    }

    if (mode === 'drop_history') {
        await IOUtils.remove(historyPath, { ignoreAbsent: true });
        return { ok: true, mode, removed: historyPath };
    }

    if (mode === 'orphan_version') {
        const orphan = (read.spec.version ?? 0) + 7;
        const path = tableVersionPath(item, orphan);
        if (!path) {
            return { ok: false, code: 'file_missing', error: 'No sidecar path.' };
        }
        await IOUtils.makeDirectory(sidecar, {
            createAncestors: true,
            ignoreExisting: true,
        });
        await IOUtils.writeUTF8(
            path,
            JSON.stringify({ ...read.spec, version: orphan })
        );
        return { ok: true, mode, version: orphan, path };
    }

    // html_ahead: the document commits a version the log never learns about.
    const ahead = (read.spec.version ?? 0) + 1;
    const document = buildTableDocument(
        { ...read.spec, version: ahead },
        { linksFor: zoteroLinksFor }
    );
    const htmlPath = await item.getFilePathAsync();
    if (!htmlPath) {
        return {
            ok: false,
            code: 'file_missing',
            error: `Table ${request.key} has no file on disk.`,
        };
    }
    await Zotero.File.putContentsAsync(htmlPath, document.html);
    return { ok: true, mode, version: ahead };
}

// ---------------------------------------------------------------------------
// The reader host (dev-only)
// ---------------------------------------------------------------------------

/**
 * Opens a stored table in the reader and reports what the enhancer attached.
 *
 * The report is deliberately literal: every step has its own field, and
 * `failures` names the ones that did not come up. A table that renders as a
 * plain static page is a supported outcome, so `ok: true` here means "the
 * attempt ran", not "everything attached" — read `enhanced`. `tab_id` is null
 * for a table opened in a reader *window* rather than a tab.
 */
export async function handleTestTableOpenReaderHttpRequest(
    request: { key?: string; libraryID?: number; timeoutMs?: number } = {}
): Promise<any> {
    if (!request.key) return MISSING_KEY;
    const libraryID = request.libraryID ?? Zotero.Libraries.userLibraryID;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, request.key) as
        | Zotero.Item
        | false;
    if (!item) {
        return {
            ok: false,
            code: 'not_found',
            error: `No item ${request.key} in library ${libraryID}`,
        };
    }
    await loadTableItemFields([item]);
    if (!isTableItem(item)) {
        return {
            ok: false,
            code: 'not_a_table',
            error: `Item ${request.key} is not a Beaver table.`,
        };
    }

    const report = await openTableInReader(item, { timeoutMs: request.timeoutMs });
    return {
        ok: true,
        key: report.itemKey,
        library_id: report.libraryID,
        enhanced: report.enhanced,
        reader_type: report.readerType,
        tab_id: report.tabID,
        is_table_item: report.isTableItem,
        // The document's own mark, carrying the format version it was written
        // with; null means the document was not one of ours (or not found).
        data_beaver_table: report.beaverTableAttribute,
        internal_reader_found: report.internalReaderFound,
        primary_view_found: report.primaryViewFound,
        view_initialized: report.viewInitialized,
        document_found: report.documentFound,
        card_mounted: report.cardMounted,
        listeners_attached: report.listenersAttached,
        markers: report.markers,
        links: report.links,
        failures: report.failures,
        views: [...listTableTabViews(), ...listReaderTableViews()],
    };
}

/**
 * Every table document currently enhanced, in either host — so lifecycle and
 * cleanup can be checked without driving the UI.
 */
export async function handleTestTableViewStateHttpRequest(): Promise<any> {
    const views = [...listTableTabViews(), ...listReaderTableViews()];
    return {
        ok: true,
        views,
        tabs: views.filter((v) => v.host === 'tab').length,
        readers: views.filter((v) => v.host === 'reader').length,
    };
}
