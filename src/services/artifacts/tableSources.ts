/**
 * The one source resolver of research tables.
 *
 * Every source a table names — the items picked by hand, a collection, a tag,
 * a saved search — is resolved here, from Zotero metadata, without opening a
 * file: the provider's `preview`, `create` and `apply_edit` use it, and so
 * does the create card (and, later, the tab's "+ Papers" and refresh). Each
 * paper becomes a row with its reference, year and identifier cells, the
 * document a fill reads (Zotero's primary attachment if it is one, else a PDF
 * over an EPUB over a snapshot), and its metadata identifiers for the merge
 * (`tableMerge.ts`). Rows from a library Beaver may not read never leave
 * here: an excluded item in an items entry is `rejected`, an excluded scope
 * is a source error.
 *
 * React-free: the webpack bundle's create card imports it too.
 */

import {
    IDENTIFIER_COLUMN_ID,
    MAX_ROWS,
    REFERENCE_COLUMN_ID,
    YEAR_COLUMN_ID,
    allocateRowId,
    type Cell,
    type Row,
    type SourceEntry,
} from '@beaver/agent-core/layouts/table';
import { identifierCell, normalizeIdentifiers, type RawIdentifiers } from '@beaver/agent-core/layouts/tableMerge';
import type { ResolvedPaper, ResolvedSource } from '@beaver/agent-core/layouts/tableEdit';
import type { TableRejectedItem } from '@beaver/agent-core/protocol/tableEditProtocol';
import { handleResolvePopulationRequest } from '../agentDataProvider/handleResolvePopulationRequest';
import { isLibrarySearchable } from '../agentDataProvider/utils';
import { getReadableContentKind } from '../documentExtraction/attachmentResolution';
import { getBestAttachmentBatch } from '../documentExtraction/attachmentInfoBatch';
import { bestDocument, type DocumentCandidate } from '../tableFills/planner';
import { libraryRefForLibraryID, parseItemReference, resolveLibraryRef } from '../../utils/libraryIdentity';
import { getIdentifiersFromItem } from '../../utils/zoteroSerializers';
import { getItemDisplayName } from '../../utils/itemDisplayName';
import { formatItemReference } from '../../utils/itemReference';

const DOCUMENT_KINDS = new Set(['pdf', 'epub', 'snapshot']);
const NOT_A_ROW = 'not a regular item; standalone attachments, notes and annotations are not table rows yet';
const NOT_FOUND = 'not found in the library (or in the trash)';
const EXCLUDED = 'in a library Beaver cannot access';
const LOOKUP_CHUNK = 200;

let sequence = 0;
const requestId = () => `table-sources-${++sequence}`;

/** Options for one resolution: the row cap a library scope is asked for. */
export interface ResolveOptions {
    rowCap?: number;
}

/** The searchable library of a portable library ref, or null. */
function searchableLibrary(libraryRef: string): number | null {
    const libraryID = resolveLibraryRef({ library_ref: libraryRef });
    return libraryID != null && Zotero.Libraries.exists(libraryID) && isLibrarySearchable(libraryID) ? libraryID : null;
}

function safe<T>(read: () => T): T | undefined {
    try {
        return read();
    } catch {
        return undefined;
    }
}

function creatorName(creator: { firstName?: string; lastName?: string; fieldMode?: number }): string {
    if (creator.fieldMode === 1) return creator.lastName ?? '';
    return `${creator.firstName ?? ''} ${creator.lastName ?? ''}`.trim();
}

/** The system cells of an item row: reference, year, identifier. */
function systemCells(item: Zotero.Item, identifiers: RawIdentifiers | null): Record<string, Cell> {
    const title = (item.getField('title', false, true) as string) || undefined;
    const creators = (item.getCreators() as { firstName?: string; lastName?: string; fieldMode?: number }[])
        .map(creatorName)
        .filter(Boolean);
    const venue = (safe(() => item.getField('publicationTitle', false, true) as string) || undefined) as string | undefined;
    const citation = safe(() => formatItemReference(item)) || undefined;
    const cells: Record<string, Cell> = {
        [REFERENCE_COLUMN_ID]: {
            outcome: 'answered',
            provenance: 'system',
            value: {
                kind: 'reference',
                display_name: safe(() => getItemDisplayName(item)) || title || 'Untitled',
                ...(title ? { title } : {}),
                ...(creators.length ? { subtitle: creators.join('; ') } : {}),
                ...(venue ? { venue } : {}),
                item_type: item.itemType,
                ...(citation ? { formatted_citation: citation } : {}),
            },
        },
    };
    const date = String(item.getField('date', false, true) || '');
    const year = /\b(\d{4})(?:-\d{2}(?:-\d{2})?)?\b/.exec(date);
    if (year) cells[YEAR_COLUMN_ID] = { outcome: 'answered', provenance: 'system', value: { kind: 'date', value: year[1] } };
    const identifier = identifierCell(normalizeIdentifiers(identifiers));
    if (identifier) cells[IDENTIFIER_COLUMN_ID] = identifier;
    return cells;
}

/**
 * The regular items behind portable ids, in id order and each once: a child
 * attachment stands for its parent; anything else that yields no row is
 * rejected with the reason.
 */
async function papersFor(ids: readonly string[]): Promise<{ items: Zotero.Item[]; rejected: TableRejectedItem[] }> {
    const items: Zotero.Item[] = [];
    const rejected: TableRejectedItem[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
        const ref = parseItemReference(id);
        const libraryID = ref ? resolveLibraryRef(ref) : null;
        if (!ref || libraryID == null || !Zotero.Libraries.exists(libraryID)) {
            rejected.push({ id, error: NOT_FOUND });
            continue;
        }
        if (!isLibrarySearchable(libraryID)) {
            rejected.push({ id, error: EXCLUDED });
            continue;
        }
        let item = (await Zotero.Items.getByLibraryAndKeyAsync(libraryID, ref.zotero_key)) as Zotero.Item | false;
        if (item && item.isAttachment() && item.parentItemID) {
            item = (await Zotero.Items.getAsync(item.parentItemID)) as Zotero.Item | false;
        }
        if (!item || item.deleted) {
            rejected.push({ id, error: NOT_FOUND });
            continue;
        }
        if (!item.isRegularItem()) {
            rejected.push({ id, error: NOT_A_ROW });
            continue;
        }
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
    }
    return { items, rejected };
}

/** Rows for regular items, in order, with their documents and identifiers. */
export async function papersFromItems(items: readonly Zotero.Item[]): Promise<ResolvedPaper[]> {
    const papers: ResolvedPaper[] = [];
    const taken = new Set<string>();
    for (let start = 0; start < items.length; start += LOOKUP_CHUNK) {
        const chunk = items.slice(start, start + LOOKUP_CHUNK);
        await Zotero.Items.loadDataTypes(chunk as Zotero.Item[], ['itemData', 'creators', 'childItems']);
        const attachmentIds = chunk.flatMap((item) => item.getAttachments(false) as number[]);
        const attachments = (await Zotero.Items.getAsync(attachmentIds)) as Zotero.Item[];
        if (attachments.length) await Zotero.Items.loadDataTypes(attachments.filter(Boolean), ['itemData']);
        const byId = new Map(attachments.filter(Boolean).map((attachment) => [attachment.id, attachment]));
        const primary = await getBestAttachmentBatch(chunk.map((item) => item.id));
        for (const item of chunk) {
            const libraryRef = libraryRefForLibraryID(item.libraryID);
            if (!libraryRef) continue;
            const candidates: DocumentCandidate[] = [];
            for (const id of item.getAttachments(false) as number[]) {
                const attachment = byId.get(id);
                if (!attachment || attachment.deleted) continue;
                const kind = getReadableContentKind(attachment);
                if (!kind || !DOCUMENT_KINDS.has(kind)) continue;
                candidates.push({
                    id: `${libraryRef}-${attachment.key}`,
                    kind: kind as DocumentCandidate['kind'],
                    primary: primary.get(item.id) === attachment.id,
                });
            }
            const document = bestDocument(candidates);
            const identifiers = (getIdentifiersFromItem(item) as RawIdentifiers | null) ?? null;
            const id = allocateRowId(taken);
            taken.add(id);
            const row: Row = {
                id,
                ref: { kind: 'item', library_ref: libraryRef, zotero_key: item.key },
                ...(document ? { documents: [document] } : {}),
                cells: systemCells(item, identifiers),
                in_library: true,
            };
            const abstract = String(item.getField('abstractNote') || '').trim();
            papers.push({ row, identifiers, mode: document ? 'document' : abstract ? 'title_abstract' : 'no_input' });
        }
    }
    return papers;
}

function failed(entry: SourceEntry, error: string): ResolvedSource {
    return { entry, papers: [], total: 0, truncated: false, rejected: [], error };
}

/**
 * One source entry: its papers as rows (without origins), its total before
 * the row cap, the ids that yield no row and why, or why it cannot be used.
 * `entry` comes back as it would be stored.
 */
export async function resolveSource(entry: SourceEntry, options: ResolveOptions = {}): Promise<ResolvedSource> {
    const rowCap = options.rowCap ?? MAX_ROWS;
    if (entry.type === 'items') {
        const { items, rejected } = await papersFor(entry.ids ?? []);
        const papers = await papersFromItems(items);
        const ids = papers.map((paper) => {
            const ref = paper.row.ref as { library_ref: string; zotero_key: string };
            return `${ref.library_ref}-${ref.zotero_key}`;
        });
        return {
            // A source with no usable item keeps the ids it was asked for.
            entry: ids.length ? { ...entry, ids } : entry,
            papers,
            total: papers.length,
            truncated: false,
            rejected,
            ...(papers.length ? {} : { error: 'None of these items can be used.' }),
        };
    }
    if (entry.type !== 'library' || !entry.scope) return failed(entry, `${entry.type} sources are not supported yet.`);
    const scope = entry.scope;
    const libraryID = searchableLibrary(scope.library_ref);
    if (libraryID == null) return failed(entry, 'This library is not available to Beaver.');
    const response = await handleResolvePopulationRequest({
        event: 'resolve_population_request',
        request_id: requestId(),
        library_id: libraryID,
        collection_keys: scope.kind === 'collection' && scope.key ? [scope.key] : null,
        // A collection includes its subcollections.
        recursive: true,
        tags: scope.kind === 'tag' && scope.tag ? [scope.tag] : null,
        unfiled: false,
        untagged: false,
        conditions:
            scope.kind === 'saved_search' && scope.key ? [{ field: 'savedSearch', operator: 'is', value: scope.key }] : [],
        item_category: 'regular',
        max_items: rowCap,
    });
    if (response.error) return failed(entry, response.error);
    const name =
        scope.kind === 'collection'
            ? response.collection_names?.[0]
            : scope.kind === 'saved_search' && scope.key
              ? response.saved_search_names?.[scope.key]
              : undefined;
    const { items, rejected } = await papersFor(response.item_ids ?? []);
    const papers = await papersFromItems(items);
    return {
        entry: name ? { ...entry, scope: { ...scope, name } } : entry,
        papers,
        total: Math.max(response.total_count ?? papers.length, papers.length),
        truncated: !!response.truncated,
        rejected,
    };
}

/** Every entry, in order. */
export async function resolveSources(entries: readonly SourceEntry[], options: ResolveOptions = {}): Promise<ResolvedSource[]> {
    const resolved: ResolvedSource[] = [];
    for (const entry of entries) resolved.push(await resolveSource(entry, options));
    return resolved;
}
