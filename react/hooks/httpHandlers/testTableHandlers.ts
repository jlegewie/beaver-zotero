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
 */

import type {
    Cell,
    Column,
    Row,
    TableSpec,
} from '@beaver/agent-core/layouts/table';
import { rowIdFor } from '@beaver/agent-core/layouts/table';
import { store } from '../../store';
import { windowSurfaceAtom, type WindowSurface } from '../../atoms/windowSurface';
import { BeaverUIFactory } from '../../../src/ui/ui';
import { getSearchableLibraryIds } from '../../../src/services/agentDataProvider/utils';
import { libraryRefForLibraryID } from '../../../src/utils/libraryIdentity';

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

function textCell(text: string): Cell {
    return text ? { value: { kind: 'text', text } } : {};
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

function referenceRow(item: DemoItem, index: number): Row {
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
                    subtitle: [item.creators, item.venue]
                        .filter(Boolean)
                        .join(' · '),
                    item_type: item.itemType,
                },
                details: item.abstract
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
        const row = referenceRow(item, i);
        row.cells.year = item.year
            ? { value: { kind: 'date', value: item.year } }
            : {};
        // Stand-in metrics: the demo is about the rendering, not the numbers.
        row.cells.cites = { value: { kind: 'number', value: (i + 1) * 137 } };
        row.cells.type = {
            value: { kind: 'select', label: selectLabelFor(item.itemType) },
        };
        row.cells.oa = { value: { kind: 'boolean', value: i % 3 !== 0 } };
        row.cells.abstract = textCell(item.abstract);
        row.cells.doi = item.doi
            ? {
                  value: {
                      kind: 'link',
                      url: `https://doi.org/${item.doi}`,
                      label: item.doi,
                  },
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
                    subtitle: 'openalex · demo-failed',
                },
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
        capabilities: { row_actions: ['reveal', 'open', 'import'] },
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
            ? { value: { kind: 'date', value: item.year } }
            : {};
        row.cells.sample = {
            ...textCell(
                item.abstract
                    ? item.abstract.split('. ').slice(0, 2).join('. ')
                    : ''
            ),
            // One hand-edited cell, so visible provenance shows up.
            provenance: i === 1 ? 'user' : undefined,
        };
        row.cells.design = {
            value: { kind: 'select', label: designs[i % designs.length] },
        };
        // A cell the producer reports nothing for is a finding, not a gap.
        row.cells.effect =
            i === 2
                ? {}
                : i === 3
                  ? { status: 'error', error: 'The PDF has no extractable text layer' }
                  : textCell(item.abstract.slice(0, 220));
        // The filling column: the first few are done, the rest are pending.
        row.cells.retention =
            i < 3 ? textCell(item.abstract.slice(0, 140)) : { status: 'pending' };
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
            row_actions: ['reveal', 'open'],
            allow_add_column: true,
            allow_add_row: true,
        },
        cost_estimate: { per_row_credits: 1, estimated_seconds: 40 },
    };
}

function selectLabelFor(itemType: string): string {
    if (itemType === 'journalArticle') return 'Journal article';
    if (itemType === 'book' || itemType === 'bookSection') return 'Book';
    if (itemType === 'preprint') return 'Preprint';
    return 'Other';
}
