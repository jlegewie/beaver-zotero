import { isTableItemError } from '../../artifacts/tableItemIdentity';
import type { Cell, Column, Row, TableSpec } from '@beaver/agent-core/layouts/table';
import { rowIdFor, validateTableSpec, type RowRef } from '@beaver/agent-core/layouts/table';
import { zoteroLinkScope, zoteroLinksFor } from '../../artifacts/view/tableLinks';
import type { TableMutation } from '@beaver/agent-core/layouts/tableMutations';
import { summarize } from '@beaver/agent-core/layouts/tableMutations';
import { getSearchableLibraryIds } from '../../agentDataProvider/utils';
import { inspectTableShadow, TABLE_SHADOW_MAX_PAYLOAD_BYTES, TABLE_SHADOW_RETENTION } from '../../artifacts/recoveryShadow';
import { buildTableDocument } from '../../artifacts/tableDocument';
import { isTableItem, loadTableItemFields, readTableItemSpec, TABLE_TAG, tableHistoryPath, tableSidecarDirectory, tableStorageDirectory, tableVersionPath } from '../../artifacts/tableItem';
import { getTablesApi, TABLES_API_UNAVAILABLE } from '../../artifacts/tablesApi';
import { createTable, deleteTable, editTable, listVersions, openTable, readTable, restoreShadowVersion, restoreTable, revertTable, trimTable, writeTable, type TableRef, type TableWriteMeta } from '../../artifacts/tableStore';
import { safeAttachmentFilename } from '../../../utils/attachmentFiles';
import { sha256Hex } from '../../../utils/hash';
import { libraryRefForLibraryID } from '../../../utils/libraryIdentity';

export const DEMO_ROW_LIMIT = 8;

export const TABLES_API_MISSING = {
    ok: false,
    code: 'tables_api_unavailable',
    error: TABLES_API_UNAVAILABLE,
};

export interface OpenTableRequest {
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

export interface DemoItem {
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
    /** Key of the item's PDF attachment, which the row's `open` verb targets. */
    attachmentKey?: string;
}

export async function collectDemoItems(limit: number): Promise<DemoItem[]> {
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
        const pdf = attachments
            .map((id) => Zotero.Items.get(id))
            .find((attachment) => attachment?.attachmentContentType === 'application/pdf');
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
            attachmentKey: pdf?.key,
        };
    });
}

export function yearOf(item: Zotero.Item): string {
    const raw = item.getField('date');
    if (!raw) return '';
    const parsed = Zotero.Date.strToDate(raw) as { year?: number };
    return parsed?.year ? String(parsed.year) : '';
}

export function citationTag(item: DemoItem, index: number): string {
    return `<citation id="${item.libraryID}-${item.key}" loc="page${index + 1}"/>`;
}

export function sentence(text: string, index: number): string {
    const parts = text.split(/(?<=\.)\s+/).filter((p) => p.trim().length > 20);
    const picked = parts[index % Math.max(1, parts.length)] ?? text;
    return picked.length > 150 ? `${picked.slice(0, 147)}…` : picked;
}

export function textCell(text: string): Cell {
    return text ? { value: { kind: 'text', text }, provenance: 'asserted' } : {};
}

export function typeColumn(items: DemoItem[]): Column {
    const labels = [...new Set(items.map((item) => typeLabelFor(item)))];
    return {
        id: '_type',
        header: 'Type',
        type: 'select',
        role: 'row_type',
        system: true,
        priority: 'secondary',
        options: labels.map((label) => ({ label, color: 'gray' })),
    };
}

export function typeLabelFor(item: DemoItem): string {
    return Zotero.ItemTypes.getLocalizedString(item.itemType) || item.itemType;
}

export function typeCell(item: DemoItem): Cell {
    return {
        value: { kind: 'select', label: typeLabelFor(item) },
        provenance: 'imported',
    };
}

export async function buildDemoTable(
    variant: 'search' | 'extraction',
    limit: number
): Promise<TableSpec> {
    const items = await collectDemoItems(limit);
    return variant === 'extraction'
        ? buildExtractionDemo(items)
        : buildSearchDemo(items);
}

export function referenceRow(item: DemoItem, index: number, withAbstract = true): Row {
    const ref: RowRef = {
        kind: 'item',
        library_id: item.libraryID,
        zotero_key: item.key,
        library_ref: item.libraryRef,
        attachment: item.attachmentKey
            ? { library_id: item.libraryID, zotero_key: item.attachmentKey, library_ref: item.libraryRef }
            : undefined,
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
            _type: typeCell(item),
        },
    };
}

export function buildSearchDemo(items: DemoItem[]): TableSpec {
    const columns: Column[] = [
        { id: 'ref', header: 'Item', type: 'reference', priority: 'primary' },
        typeColumn(items),
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

export function buildExtractionDemo(items: DemoItem[]): TableSpec {
    const columns: Column[] = [
        { id: 'ref', header: 'Item', type: 'reference', priority: 'primary' },
        typeColumn(items),
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

export function selectLabelFor(itemType: string): string {
    if (itemType === 'journalArticle') return 'Journal article';
    if (itemType === 'book' || itemType === 'bookSection') return 'Book';
    if (itemType === 'preprint') return 'Preprint';
    return 'Other';
}

export interface TableCreateRequest extends OpenTableRequest {
    operation_id?: string;
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
            operation_id: request.operation_id,
            title: request.title,
            libraryID: request.libraryID,
            collectionID: request.collectionID,
            ...writeMetaFrom(request),
        });
        return {
            ok: true,
            key: created.key,
            sha256: created.sha256 ?? created.entry.sha256,
            replayed: created.replayed,
            operation: created.operation,
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

export interface TableReadRequest {
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

export function errorResponse(error: unknown): any {
    const code = isTableItemError(error) ? error.code : 'unexpected_error';
    return {
        ok: false,
        code,
        error: isTableItemError(error) ? error.message : String(error),
    };
}

export interface TableStoreRequest {
    key?: string;
    libraryID?: number;
    actor?: string;
    run_id?: string;
    thread_id?: string;
    change?: string;
}

export function tableRefFrom(request: TableStoreRequest): TableRef | null {
    if (!request.key) return null;
    return {
        libraryID: request.libraryID ?? Zotero.Libraries.userLibraryID,
        key: request.key,
    };
}

export function writeMetaFrom(request: TableStoreRequest): TableWriteMeta {
    const actor =
        request.actor === 'user' || request.actor === 'system' ? request.actor : 'agent';
    return {
        actor,
        run_id: request.run_id,
        thread_id: request.thread_id,
        change: request.change,
    };
}

export const MISSING_KEY = { ok: false, code: 'invalid_request', error: 'key is required' };

export function writeResponse(
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
            sha256: result.sha256,
        };
    }
    return {
        ok: true,
        version: result.version,
        sha256: result.sha256,
        replayed: result.replayed,
        operation: result.operation,
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

export interface TableWriteRequest extends TableStoreRequest {
    spec?: TableSpec;
    expectedVersion?: number;
    expected_sha256?: string;
    operation_id?: string;
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
                request.expectedVersion,
                request.operation_id !== undefined || request.expected_sha256 !== undefined
                    ? {
                          operation_id: request.operation_id ?? '',
                          expected_sha256: request.expected_sha256 ?? '',
                      }
                    : undefined
            )
        );
    } catch (error) {
        return errorResponse(error);
    }
}

export interface TableEditRequest extends TableStoreRequest {
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

export interface TableRevertRequest extends TableStoreRequest {
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

export interface TableDeleteRequest extends TableStoreRequest {
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
            sha256: opened.sha256,
            recovered: opened.recovered,
            // Null on every table this device is still ahead of. Deliberately
            // separate from `recovered`: nothing has been repaired.
            conflict: opened.conflict,
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

export interface TableCorruptRequest {
    key?: string;
    libraryID?: number;
    mode?: 'drop_history' | 'orphan_version' | 'html_ahead' | 'sync_conflict';
    /** `sync_conflict` only: the version to roll the table back to. */
    toVersion?: number;
}

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

    if (mode === 'sync_conflict') {
        return rollBackWholeDirectory(item, read.spec, sidecar, historyPath, request.toVersion);
    }

    // html_ahead: the document commits a version the log never learns about.
    const ahead = (read.spec.version ?? 0) + 1;
    const document = buildTableDocument(
        { ...read.spec, version: ahead },
        { linksFor: zoteroLinksFor, citationScopeFor: zoteroLinkScope }
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

export async function rollBackWholeDirectory(
    item: Zotero.Item,
    current: TableSpec,
    sidecar: string,
    historyPath: string,
    requested?: number
): Promise<any> {
    const currentVersion = current.version ?? 0;
    const target = requested ?? currentVersion - 1;
    if (!Number.isInteger(target) || target < 1 || target >= currentVersion) {
        return {
            ok: false,
            code: 'invalid_request',
            error: `toVersion must be between 1 and ${currentVersion - 1}; the table is at ${currentVersion}.`,
        };
    }

    const targetPath = tableVersionPath(item, target);
    const htmlPath = await item.getFilePathAsync();
    if (!targetPath || !htmlPath) {
        return { ok: false, code: 'file_missing', error: 'No path for the target version.' };
    }

    let spec: TableSpec = current;
    if (await IOUtils.exists(targetPath)) {
        const stored = JSON.parse(await IOUtils.readUTF8(targetPath)) as TableSpec;
        if (validateTableSpec(stored).length === 0) spec = stored;
    }
    spec = { ...spec, version: target };

    const serialized = JSON.stringify(spec);
    const sha256 = await sha256Hex(serialized);

    await IOUtils.makeDirectory(sidecar, { createAncestors: true, ignoreExisting: true });
    await IOUtils.writeUTF8(targetPath, serialized);

    // The log the other device would have shipped: everything up to the target,
    // with the target's entry describing the bytes just written.
    const history = JSON.parse(await IOUtils.readUTF8(historyPath).catch(() => '{}')) as {
        versions?: Array<Record<string, unknown>>;
    };
    const kept = (Array.isArray(history.versions) ? history.versions : []).filter(
        (entry) => typeof entry.version === 'number' && entry.version < target
    );
    kept.push({
        version: target,
        actor: 'system',
        at: new Date().toISOString(),
        sha256,
        summary: summarize(spec),
        change: 'Synced from another device',
        sealed: true,
    });
    await IOUtils.writeUTF8(historyPath, JSON.stringify({ tip: target, versions: kept }));

    const removed: number[] = [];
    for (const child of await IOUtils.getChildren(sidecar).catch(() => [])) {
        const match = /^v(\d+)\.json$/.exec(PathUtils.filename(child));
        if (match && Number(match[1]) > target) {
            await IOUtils.remove(child, { ignoreAbsent: true });
            removed.push(Number(match[1]));
        }
    }

    await Zotero.File.putContentsAsync(
        htmlPath,
        buildTableDocument(spec, {
            linksFor: zoteroLinksFor,
            citationScopeFor: zoteroLinkScope,
        }).html
    );

    return {
        ok: true,
        mode: 'sync_conflict',
        from_version: currentVersion,
        version: target,
        sha256,
        removed_versions: removed.sort((a, b) => a - b),
    };
}

export async function handleTestTableShadowHttpRequest(
    request: TableStoreRequest = {}
): Promise<any> {
    const ref = tableRefFrom(request);
    if (!ref) return MISSING_KEY;
    try {
        const current = await readTable(ref);
        const report = await inspectTableShadow(ref, {
            version: current.version,
            sha256: await sha256Hex(JSON.stringify(current.spec)),
        });
        return {
            ok: true,
            key: ref.key,
            library_id: ref.libraryID,
            document_version: current.version,
            retention: TABLE_SHADOW_RETENTION,
            max_payload_bytes: TABLE_SHADOW_MAX_PAYLOAD_BYTES,
            total_bytes: report.totalBytes,
            last: report.last,
            entries: report.entries,
            conflict: report.conflict,
        };
    } catch (error) {
        return errorResponse(error);
    }
}

export async function handleTestTableRestoreShadowHttpRequest(
    request: TableStoreRequest = {}
): Promise<any> {
    const ref = tableRefFrom(request);
    if (!ref) return MISSING_KEY;
    try {
        const result = await restoreShadowVersion(ref, writeMetaFrom(request));
        if (!result.ok) {
            return {
                ok: false,
                code: result.code,
                error: result.error,
                version: result.version,
            };
        }
        return {
            ok: true,
            version: result.version,
            restored_from: result.restoredFrom,
            entry: result.entry,
        };
    } catch (error) {
        return errorResponse(error);
    }
}

export async function handleTestTableViewStateHttpRequest(): Promise<any> {
    const api = getTablesApi();
    if (!api) return TABLES_API_MISSING;
    return { ok: true, views: api.listViews() };
}

export async function handleTestTableItemPaneHttpRequest(
    request: { key?: string; libraryID?: number } = {}
): Promise<any> {
    if (!request.key) return MISSING_KEY;
    const api = getTablesApi();
    if (!api) return TABLES_API_MISSING;

    const ref: TableRef = {
        libraryID: request.libraryID ?? Zotero.Libraries.userLibraryID,
        key: request.key,
    };
    const report = await api.itemPane.describe(ref);
    return {
        ok: report.applies,
        registered: report.registered,
        pane_id: report.paneID,
        key: report.key,
        library_id: report.libraryID,
        applies: report.applies,
        reason: report.reason,
        fields: report.fields,
        actions: report.actions,
    };
}

export async function handleTestTableTrimHttpRequest(
    request: TableStoreRequest & { run_ids?: string[] } = {}
): Promise<any> {
    const ref = tableRefFrom(request);
    if (!ref) return MISSING_KEY;
    try {
        return await trimTable(ref, { thread_id: request.thread_id ?? '', run_ids: request.run_ids ?? [] });
    } catch (error) {
        return errorResponse(error);
    }
}
