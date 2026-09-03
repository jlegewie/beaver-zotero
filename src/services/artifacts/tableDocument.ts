/**
 * Renders a `TableSpec` as self-contained HTML.
 *
 * This is the third rendering of the same data model, beside the React grid
 * (`@beaver/agent-ui/layouts`) and — later — the Word add-in. It exists because
 * the other two need a live React tree and the two places this one goes do not:
 * a saved snapshot, and a temporary Zotero tab.
 *
 * ## No script, so interaction is CSS
 *
 * Zotero's snapshot reader loads documents under a CSP whose `script-src` has no
 * `'unsafe-inline'`: author JavaScript never runs (see `reportHtml.ts` for the
 * full policy). Rather than ship a static table there and an interactive one in
 * a tab, everything here is done with form controls and selectors, so the same
 * document sorts, filters and expands in both:
 *
 * - **Sort** — a radio per column and direction. Every row carries its rank in
 *   each sortable column as a custom property, and the checked radio maps that
 *   rank onto `order` in a flex column. Ascending and descending are each their
 *   own pass (empty cells last in both — not `n - asc`).
 * - **Filter** — a radio group per select or boolean column, each non-matching
 *   value hidden by one rule.
 * - **Row height** — a radio group swapping the line clamps and the row height.
 * - **Expand** — `<details>`, which needs neither script nor a rule.
 *
 * Rows are also emitted already sorted by `spec.sort`, so a renderer that
 * supports none of the above still shows the table the producer intended.
 *
 * What is deliberately absent rather than faked: selection (its only purpose is
 * bulk verbs that cannot run here) and add-column (same). Row verbs are emitted
 * as links; a host that wants them to do something intercepts the clicks.
 *
 * ## Layout
 *
 * A flex column of grid rows rather than a `<table>`: `order` is what makes
 * CSS-only sorting possible, and table rows cannot be reordered. Alignment
 * comes from every row sharing one `grid-template-columns`.
 *
 * This module is free of Zotero APIs — callers pass prebuilt link URIs and a
 * library-scope resolver, exactly as `reportHtml.ts` does.
 *
 * ## The document is the table
 *
 * A stored table is a snapshot attachment and nothing else: no database row, no
 * server copy. So the document carries the spec it was rendered from, and
 * {@link parseTableDocument} reads it back — see {@link buildTableDocument}.
 *
 * That makes rendering a **pure function of its inputs**: no clock, no random
 * ids, no iteration over anything whose order is not fixed by the spec, so the
 * same spec always produces the same bytes and a re-render never moves text
 * that annotations are anchored to. The deliberate exceptions are the two
 * options that consult live Zotero state — `linksFor` (does this item still
 * have a file?) and `citationScopeFor` (is this library a group here?) — so
 * two renders of the same spec may differ in their links.
 */

import {
    anchorColumn,
    cellSortKey,
    citationsByKey,
    columnAlign,
    compareSortKeys,
    isColumnFilterable,
    isColumnSortable,
    readSpec,
    rowActions,
    selectLabelsInColumn,
    sortRows,
    summarizeCoverage,
    CITATION_TAG_RE,
    SELECT_COLORS,
    TABLE_SPEC_VERSION,
    type Cell,
    type Column,
    type Row,
    type RowAction,
    type TableSpec,
} from '@beaver/agent-core/layouts/table';
import {
    normalizeCitationTag,
    parseRawCitationAttributes,
    requestedCitationKey,
} from '@beaver/agent-core/citations/citationGrammar';
import type { Citation } from '@beaver/agent-core/types/citations';
import { countTopLevelCssRules, escapeHtml, CSS_RULE_BUDGET } from '../../utils/html';

/**
 * The href behind each of a row's verbs, keyed by verb. A verb with no entry
 * gets no link; a verb that cannot be a link at all (`import` is a library
 * write) is never emitted here.
 */
export type TableHtmlLinks = Partial<Record<RowAction, string | null>>;

export interface TableHtmlOptions {
    /**
     * Emits the sort, filter and row-height controls. Off gives a plain
     * document sorted as the producer intended — the tier for a renderer that
     * strips form controls, and for a table small enough not to need them.
     */
    controls?: boolean;
    /** Per-row links. Rows it returns nothing for get no action links. */
    linksFor?: (row: Row) => TableHtmlLinks;
    /**
     * The `zotero://` path scope for a cited item's library (`library` or
     * `groups/<groupID>`). This module has no Zotero, so the host supplies it —
     * the same `zoteroLinkScope` the row links use. Absent, every citation names
     * the personal library, which is all a caller with no Zotero can assume.
     */
    citationScopeFor?: (libraryId: number) => string;
    /** Prefix for generated element ids, so two tables can share a document. */
    idPrefix?: string;
}

/** Personal-library scope when the host does not supply {@link TableHtmlOptions.citationScopeFor}. */
const USER_LIBRARY_SCOPE = () => 'library';

export interface RenderedTable {
    /** A fragment. `buildTableDocument` wraps it; a report embeds it. */
    html: string;
    /**
     * Top-level rules in the emitted stylesheet, for budget assertions. From
     * `renderTableHtml` this counts only the per-table rules the fragment
     * carries; the caller adds {@link TABLE_CSS} and counts that too.
     */
    cssRuleCount: number;
}

// ---------------------------------------------------------------------------
// Widths
// ---------------------------------------------------------------------------

const RAIL_WIDTH = '2.6rem';
const ACTIONS_WIDTH = '5rem';
const FLEX_COLUMN_MIN = 'minmax(14rem, 1.6fr)';

/**
 * Mirrors the React renderer's per-type defaults so the two look like the same
 * table. A text column flexes; everything else is sized to its content.
 */
function columnWidth(column: Column, isAnchor: boolean): string {
    if (column.width != null)
        return column.width === 'fill' ? FLEX_COLUMN_MIN : `${column.width}px`;
    if (isAnchor) return '20rem';
    switch (column.type) {
        case 'reference':
            return '16rem';
        case 'number':
        case 'date':
            // Wider than the React grid's: the sort control sits in the header
            // here rather than appearing on hover, so the label needs room
            // beside it.
            return '8rem';
        case 'boolean':
            return '5rem';
        case 'select':
            return '9.5rem';
        case 'link':
            return '10rem';
        default:
            return FLEX_COLUMN_MIN;
    }
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

/**
 * Inline copies of the icons the React renderer uses, so the two tables carry
 * the same marks. Inline because the snapshot CSP admits no `chrome:` images
 * and the document has to stand alone.
 */
const CHEVRON_SVG =
    '<svg class="bt-chev" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M9 6C9 6 15 10.4189 15 12C15 13.5812 9 18 9 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ARROW_UP_RIGHT_SVG =
    '<svg class="bt-gl" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M16.5 7.5L6 18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M8 6.18791C8 6.18791 16.0479 5.50949 17.2692 6.73079C18.4906 7.95209 17.812 16 17.812 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const CHEVRON_DOWN_SVG =
    '<svg class="bt-gl" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const CHEVRON_UP_SVG =
    '<svg class="bt-gl" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="m6 15 6-6 6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Both directions at once — a sortable column at rest. */
const SORT_BOTH_SVG =
    '<svg class="bt-gl" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="m7 10 5-5 5 5M7 14l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/**
 * The pill colour for a select label. Checked against agent-core's palette
 * rather than a list restated here: a colour added there but missing from a
 * local copy renders as grey in every stored table.
 */
function selectHue(label: string, column: Column): string {
    const declared = column.options?.find((o) => o.label === label)?.color;
    return declared && (SELECT_COLORS as readonly string[]).includes(declared)
        ? declared
        : 'gray';
}

/**
 * Grouped digits in a fixed locale rather than the host's.
 *
 * The rendered document is stored and re-read, so it has to be the same
 * everywhere: a bare `toLocaleString()` groups by the install's locale (and in
 * some locales changes the digits themselves), which would make the same spec
 * render differently on two machines.
 */
function formatNumber(value: number): string | null {
    // JSON has no NaN or Infinity, so a non-finite value cannot survive a save:
    // `JSON.stringify` writes it as `null`, and a reloaded table would then
    // render `null.toLocaleString()`. Treated as no value in both directions,
    // the way `cellSortKey` already treats it.
    return Number.isFinite(value) ? value.toLocaleString('en-US') : null;
}

/** Only `zotero:` and `https:` become links; anything else renders as text. */
function safeHref(uri: string | null | undefined): string | null {
    if (!uri) return null;
    return /^(zotero:\/\/|https:\/\/)/i.test(uri) ? uri : null;
}

function renderCellValue(
    cell: Cell | undefined,
    column: Column,
    cites?: CitationNumbering
): string {
    if (cell?.status === 'pending') {
        return '<span class="bt-pending">Filling…</span>';
    }
    if (cell?.status === 'error') {
        return `<span class="bt-err">${escapeHtml(cell.error ?? 'Could not be extracted')}</span>`;
    }
    // Nothing at all, rather than a placeholder glyph: a column of em dashes
    // reads as noise across a wide table, and the footer already counts what
    // is missing.
    const value = cell?.value;
    if (!value) return '<span class="bt-empty"></span>';

    switch (value.kind) {
        case 'text':
            return `<span class="bt-clamp">${
                cites ? cites.render(value.text) : escapeHtml(value.text)
            }</span>`;

        case 'number': {
            const shown = value.display ?? formatNumber(value.value);
            if (shown === null) return '<span class="bt-empty"></span>';
            return `<span class="bt-num">${escapeHtml(
                shown
            )}${column.unit && !value.display ? `<span class="bt-unit">${escapeHtml(column.unit)}</span>` : ''}</span>`;
        }

        case 'date':
            return `<span class="bt-num">${escapeHtml(value.display ?? value.value)}</span>`;

        case 'boolean':
            // The check is the signal; false is its absence.
            return value.value
                ? '<span class="bt-yes" title="yes">✓</span>'
                : '<span class="bt-no"></span>';

        case 'select':
            return `<span class="bt-pill bt-pill--${selectHue(value.label, column)}">${escapeHtml(value.label)}</span>`;

        case 'reference': {
            const authors = value.subtitle
                ? `<span class="bt-authors">${escapeHtml(value.subtitle)}</span>`
                : '';
            const venue = value.venue
                ? `<span class="bt-venue">${escapeHtml(value.venue)}</span>`
                : '';
            const meta =
                authors || venue ? `<span class="bt-sub">${authors}${venue}</span>` : '';
            return `<span class="bt-ref"><span class="bt-title">${escapeHtml(value.display_name)}</span>${meta}</span>`;
        }

        case 'annotation': {
            // Same frame as a reference: the passage where the title goes, the
            // source and page where the authors go. The comment is context and
            // shows only in the expanded row.
            const title = value.text ?? value.comment ?? 'Annotation';
            const meta = [
                value.source_display_name,
                value.page_label ? `p. ${value.page_label}` : undefined,
            ]
                .filter(Boolean)
                .join(' · ');
            const sub = meta ? `<span class="bt-sub">${escapeHtml(meta)}</span>` : '';
            const comment =
                value.text && value.comment
                    ? `<span class="bt-ann-comment">${escapeHtml(value.comment)}</span>`
                    : '';
            return `<span class="bt-ref"><span class="bt-title">${escapeHtml(title)}</span>${sub}${comment}</span>`;
        }

        case 'link': {
            const href = safeHref(value.url);
            const label = escapeHtml(value.label ?? value.url);
            return href
                ? `<a class="bt-link" href="${escapeHtml(href)}" data-bt-external="1">${label}</a>`
                : `<span class="bt-empty">${label}</span>`;
        }

        default:
            return '<span class="bt-empty"></span>';
    }
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/**
 * Numbers every citation in the table and renders each tag as a marker.
 *
 * The marker is what the chat's `Citation` renders: a small superscript number
 * that says where the claim came from, opens the cited page when clicked, and
 * shows the source and the cited passage on hover. Here it is a `zotero://`
 * link — which navigates on its own from a content docshell — and a native
 * `title`, because the cell it sits in is clamped with `overflow: hidden` and
 * would clip any card drawn inside it. A host that can do better upgrades the
 * hover from outside the document; see `view/enhanceTableDocument.ts`.
 *
 * Markers are assigned in document order across the whole table, so the same
 * source keeps one number wherever it is cited and the bibliography reads in
 * the order a person meets them.
 */
class CitationNumbering {
    private readonly byKey: Record<string, Citation>;
    private readonly markers = new Map<string, number>();
    private readonly scopeFor: (libraryId: number) => string;
    /** Every cited source, in the order its marker was assigned. */
    readonly cited: Array<{ marker: number; key: string; citation?: Citation }> = [];

    constructor(
        citations: Citation[] | undefined,
        scopeFor: (libraryId: number) => string = USER_LIBRARY_SCOPE
    ) {
        this.byKey = citationsByKey(citations);
        this.scopeFor = scopeFor;
    }

    /**
     * `zotero://open` at the first cited page, or the item if there is none.
     * Shared with the bibliography so a marker and its entry always agree.
     */
    hrefFor(citation: Citation | undefined): string | null {
        const ref = citation?.resolved_ref ?? citation?.requested_ref;
        if (!ref || !('zotero_key' in ref) || !ref.zotero_key) return null;
        const page = citation?.pages?.[0];
        const base = `zotero://open/${this.scopeFor(ref.library_id)}/items/${ref.zotero_key}`;
        return page ? `${base}?page=${page}` : base;
    }

    private markerFor(key: string): number {
        const existing = this.markers.get(key);
        if (existing) return existing;
        const marker = this.markers.size + 1;
        this.markers.set(key, marker);
        this.cited.push({ marker, key, citation: this.byKey[key] });
        return marker;
    }

    /** Escapes `text` and swaps each citation tag for its marker. */
    render(text: string): string {
        let out = '';
        let last = 0;
        CITATION_TAG_RE.lastIndex = 0;
        for (const match of text.matchAll(CITATION_TAG_RE)) {
            const at = match.index ?? 0;
            out += escapeHtml(text.slice(last, at));
            last = at + match[0].length;

            const normalized = normalizeCitationTag(
                parseRawCitationAttributes(match[1] || '')
            );
            // An unparseable tag is dropped rather than shown raw: a stray
            // `<citation …/>` in a cell is noise the reader cannot act on.
            if (!normalized.ok) continue;
            const key = requestedCitationKey(normalized.ref);
            out += this.marker(this.markerFor(key), this.byKey[key]);
        }
        return out + escapeHtml(text.slice(last));
    }

    private marker(marker: number, citation: Citation | undefined): string {
        const href = this.hrefFor(citation);
        const parts = citationParts(citation);
        const attrs = [
            `class="bt-cite bt-cite--${citationTone(citation)}"`,
            // The tooltip's parts, kept apart so a host can lay them out the
            // way the app does; `title` is the fallback where none can.
            parts.name ? `data-cite-name="${escapeHtml(parts.name)}"` : '',
            parts.locator ? `data-cite-loc="${escapeHtml(parts.locator)}"` : '',
            parts.preview ? `data-cite-preview="${escapeHtml(parts.preview)}"` : '',
            parts.action ? `data-cite-action="${escapeHtml(parts.action)}"` : '',
            parts.title ? `title="${escapeHtml(parts.title)}"` : '',
            `data-bt-cite="${marker}"`,
        ]
            .filter(Boolean)
            .join(' ');
        return href
            ? `<a ${attrs} href="${escapeHtml(href)}">${marker}</a>`
            : `<span ${attrs}>${marker}</span>`;
    }
}

/**
 * The three colours the app gives a citation, by what it points at: green when
 * it carries a locator and lands on a passage, blue for an external reference,
 * grey for a plain item citation.
 */
function citationTone(citation: Citation | undefined): 'locator' | 'external' | 'item' {
    if (!citation) return 'item';
    const ref = citation.resolved_ref ?? citation.requested_ref;
    if (ref && ref.kind === 'external') return 'external';
    if (citation.pages?.length || (ref && 'loc' in ref && ref.loc)) return 'locator';
    return 'item';
}

/** What the chat's citation card shows, in the pieces it shows them in. */
function citationParts(citation: Citation | undefined): {
    name?: string;
    locator?: string;
    preview?: string;
    action?: string;
    title?: string;
} {
    if (!citation) return {};
    const name = citation.display_name ?? citation.formatted_citation;
    const locator = citation.pages?.length
        ? `Page ${citation.pages.join(', ')}`
        : undefined;
    // The passage as the app quotes it: trimmed, and in quotation marks so it
    // reads as something lifted from the source rather than as prose of ours.
    const raw = citation.preview?.replace(/\s+/g, ' ').trim();
    const preview = raw ? `"${raw}${/[.!?"']$/.test(raw) ? '' : '…'}"` : undefined;
    const action = locator
        ? `Highlights passage on ${locator.toLowerCase()}`
        : citation.filename
          ? 'Opens the cited file'
          : undefined;
    const title = [name, locator, preview].filter(Boolean).join(' — ');
    return { name, locator, preview, action, title: title || undefined };
}

// ---------------------------------------------------------------------------
// Ranks
// ---------------------------------------------------------------------------

interface RowRanks {
    /** Ascending position per sortable column, as `--o<i>`. */
    asc: number[];
    /** Descending position per sortable column, as `--p<i>`. */
    desc: number[];
}

/**
 * Each row's position in each column, in both directions.
 *
 * This is what lets the checked radio reorder a flex container without script:
 * the ranks are computed once here, and the rule for a column maps them onto
 * `order`. Descending needs its own pass rather than `n - asc`, because empty
 * cells sort last in *either* direction — reversing the ascending order would
 * lead with them, which is how a failed row ends up at the top of a table
 * sorted by citation count.
 */
function sortRanks(rows: Row[], columns: Column[]): Map<string, RowRanks> {
    const ranks = new Map<string, RowRanks>(
        rows.map((r) => [r.id, { asc: [], desc: [] }])
    );
    for (const column of columns) {
        const keyed = rows.map((row, index) => ({
            row,
            index,
            key: cellSortKey(row.cells[column.id]),
        }));
        for (const direction of ['asc', 'desc'] as const) {
            const ordered = keyed.slice().sort((a, b) => {
                const cmp = compareSortKeys(a.key, b.key, direction);
                return cmp !== 0 ? cmp : a.index - b.index;
            });
            ordered.forEach((entry, position) =>
                ranks.get(entry.row.id)![direction].push(position)
            );
        }
    }
    return ranks;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

interface FilterGroup {
    column: Column;
    /** Radio value labels; the first is always "All". */
    options: string[];
    /** Class each option matches, aligned with `options` after the first. */
    classes: string[];
}

/**
 * The label list each `select` column filters on, keyed by column id.
 *
 * Built once and shared, because the chip in the toolbar and the class on the
 * row are two halves of one index: a chip is `bt-v<col>-<n>` and it hides every
 * row that does not carry that class. Enumerating the labels twice — once over
 * the sorted rows and once over the spec's — silently pairs "Alpha" with
 * "Zeta"'s rows the moment an undeclared select column is sorted.
 *
 * Enumerated over the rows in display order, so an open select's chips read in
 * the order the values appear on screen.
 */
function selectFilterLabels(
    spec: TableSpec,
    sortedRows: Row[]
): Map<string, string[]> {
    const byColumn = new Map<string, string[]>();
    for (const column of spec.columns) {
        if (column.type !== 'select') continue;
        byColumn.set(
            column.id,
            column.options?.length
                ? column.options.map((o) => o.label)
                : selectLabelsInColumn({ ...spec, rows: sortedRows }, column.id)
        );
    }
    return byColumn;
}

function filterGroups(
    spec: TableSpec,
    selectLabels: Map<string, string[]>
): FilterGroup[] {
    const groups: FilterGroup[] = [];
    for (const [index, column] of spec.columns.entries()) {
        if (!isColumnFilterable(column)) continue;

        if (column.type === 'select') {
            const labels = selectLabels.get(column.id) ?? [];
            if (labels.length > 1) {
                groups.push({
                    column,
                    options: ['All', ...labels],
                    classes: labels.map((_, i) => `bt-v${index}-${i}`),
                });
            }
        }

        if (column.type === 'boolean') {
            groups.push({
                column,
                options: ['All', 'Yes', 'No'],
                classes: [`bt-v${index}-1`, `bt-v${index}-0`],
            });
        }
    }
    return groups;
}

/** The classes a row carries so the filter rules can hide it. */
function rowFilterClasses(
    row: Row,
    spec: TableSpec,
    selectLabels: Map<string, string[]>
): string[] {
    const classes: string[] = [];
    for (const [index, column] of spec.columns.entries()) {
        const value = row.cells[column.id]?.value;
        if (!value) continue;
        if (value.kind === 'select') {
            const labels = selectLabels.get(column.id) ?? [];
            const at = labels.indexOf(value.label);
            if (at >= 0) classes.push(`bt-v${index}-${at}`);
        }
        if (value.kind === 'boolean') {
            classes.push(`bt-v${index}-${value.value ? 1 : 0}`);
        }
    }
    return classes;
}

/**
 * The action links for one row, resolved once and handed to both places that
 * show them — the actions cell and the expanded detail.
 */
function resolveRowLinks(
    row: Row,
    links: TableHtmlOptions['linksFor'] | undefined
): TableHtmlLinks | null {
    if (!links || !row.ref) return null;
    return links(row) ?? {};
}

/** Glyph and label of each verb a static rendering can draw as a link. */
const ACTION_LINKS: Partial<Record<RowAction, { glyph: string; label: string }>> = {
    reveal: { glyph: ARROW_UP_RIGHT_SVG, label: 'Reveal in library' },
    open: { glyph: '▤', label: 'Open' },
};

function renderActions(row: Row, spec: TableSpec, links: TableHtmlLinks | null): string {
    if (!links) return '';
    const parts: string[] = [];
    for (const verb of rowActions(spec, row)) {
        // A verb the host gave no URI for gets no link rather than a dead one.
        // Import never has one: it is a library write that needs the approval
        // pipeline, which no static document can reach.
        const link = ACTION_LINKS[verb];
        const href = safeHref(links[verb]);
        if (!link || !href) continue;
        parts.push(
            `<a class="bt-act" href="${escapeHtml(href)}" title="${link.label}" aria-label="${link.label}">${link.glyph}</a>`
        );
    }
    return parts.join('');
}

function renderDetail(
    row: Row,
    spec: TableSpec,
    links: TableHtmlLinks | null,
    cites: CitationNumbering
): string {
    const fields = spec.columns
        .filter((column) => {
            const cell = row.cells[column.id];
            return !!cell?.value || !!cell?.details || !!cell?.status;
        })
        .map((column) => {
            const cell = row.cells[column.id];
            const details = cell?.details
                ? cell.details.kind === 'text'
                    ? `<div class="bt-d-extra">${cites.render(cell.details.text)}</div>`
                    : `<ul class="bt-d-list">${cell.details.items
                          .map((item) => `<li>${cites.render(item)}</li>`)
                          .join('')}</ul>`
                : '';
            return [
                `<dt>${escapeHtml(column.header)}</dt>`,
                `<dd>${renderCellValue(cell, column, cites)}${details}</dd>`,
            ].join('');
        })
        .join('');

    const error =
        row.status === 'error' && row.error
            ? `<p class="bt-d-err">${escapeHtml(row.error)}</p>`
            : '';

    const actions = renderActions(row, spec, links);
    return `<div class="bt-d">${error}<dl class="bt-d-fields">${fields}</dl>${
        actions ? `<div class="bt-d-actions">${actions}</div>` : ''
    }</div>`;
}

/**
 * The table as a fragment.
 *
 * `idPrefix` namespaces every form control, because the radios that drive sort
 * and filtering are real elements in the document: two tables sharing a prefix
 * would drive each other.
 */
export function renderTableHtml(
    spec: TableSpec,
    options: TableHtmlOptions = {}
): RenderedTable {
    const prefix = options.idPrefix ?? 'bt';
    const controls = options.controls ?? true;
    const anchor = anchorColumn(spec);
    const cites = new CitationNumbering(spec.citations, options.citationScopeFor);
    const rows = sortRows(spec, spec.sort);
    const ranks = sortRanks(rows, spec.columns);
    // Asked once per row, used twice: the actions cell and the expanded detail
    // show the same links. The column exists only if some row has a verb the
    // host gave a link for — an import-only or context-file table would
    // otherwise reserve the width for cells that are all empty.
    const rowLinks = new Map(
        rows.map((row) => [row.id, resolveRowLinks(row, options.linksFor)] as const)
    );
    const hasActions = rows.some(
        (row) => renderActions(row, spec, rowLinks.get(row.id) ?? null) !== ''
    );

    const hasQuestions = spec.columns.some((c) => !!c.description);

    const template = [
        RAIL_WIDTH,
        ...spec.columns.map((c) => columnWidth(c, c.id === anchor?.id)),
        hasActions ? ACTIONS_WIDTH : '',
    ]
        .filter(Boolean)
        .join(' ');

    // --- the radios that drive everything, before the body so `~` can reach it
    const sortInputs: string[] = [];
    if (controls) {
        spec.columns.forEach((column, i) => {
            if (!isColumnSortable(column)) return;
            for (const dir of ['a', 'd'] as const) {
                const checked =
                    spec.sort?.column_id === column.id &&
                    (spec.sort.direction === 'asc') === (dir === 'a');
                sortInputs.push(
                    `<input type="radio" name="${prefix}-sort" id="${prefix}-s${dir}${i}" class="bt-ctl"${checked ? ' checked' : ''}>`
                );
            }
        });
        // A resting state, so the baked DOM order can be restored.
        sortInputs.push(
            `<input type="radio" name="${prefix}-sort" id="${prefix}-s0" class="bt-ctl"${spec.sort ? '' : ' checked'}>`
        );
    }

    // Every control costs rules, and past the reader's budget it stops theming
    // the document properly — so a table wide enough to blow it loses its
    // filters, which are far and away the most expensive, and keeps its sort.
    const selectLabels = selectFilterLabels(spec, rows);
    const wanted = controls ? filterGroups(spec, selectLabels) : [];
    const groups = controls && fitsBudget(spec, prefix, wanted) ? wanted : [];
    const filterInputs = groups
        .map((group, g) =>
            group.options
                .map(
                    (_, o) =>
                        `<input type="radio" name="${prefix}-f${g}" id="${prefix}-f${g}-${o}" class="bt-ctl"${o === 0 ? ' checked' : ''}>`
                )
                .join('')
        )
        .join('');

    const densityInputs = controls
        ? ['c', 'z', 't']
              .map(
                  (d) =>
                      `<input type="radio" name="${prefix}-d" id="${prefix}-d${d}" class="bt-ctl"${d === 'z' ? ' checked' : ''}>`
              )
              .join('')
        : '';

    // --- toolbar
    const densityBar = controls
        ? `<span class="bt-seg">${[
              ['c', 'Compact rows'],
              ['z', 'Cozy rows'],
              ['t', 'Tall rows'],
          ]
              .map(
                  ([d, label]) =>
                      `<label class="bt-seg-o bt-seg-${d}" for="${prefix}-d${d}" title="${label}"><i></i></label>`
              )
              .join('')}</span>`
        : '';

    const filterBar = groups
        .map(
            (group, g) =>
                `<span class="bt-fg"><span class="bt-fg-h">${escapeHtml(group.column.header)}</span>${group.options
                    .map(
                        (label, o) =>
                            `<label class="bt-fo bt-fo${g}-${o}" for="${prefix}-f${g}-${o}">${escapeHtml(label)}</label>`
                    )
                    .join('')}</span>`
        )
        .join('');

    const coverage = summarizeCoverage(spec, rows);
    const footerParts = [`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`];
    if (coverage.pending > 0) footerParts.push(`${coverage.pending} filling`);
    if (coverage.empty > 0) footerParts.push(`${coverage.empty} not reported`);
    if (coverage.error > 0) footerParts.push(`${coverage.error} failed`);
    if (coverage.errorRows > 0)
        footerParts.push(
            `${coverage.errorRows} ${coverage.errorRows === 1 ? 'row' : 'rows'} incomplete`
        );

    // --- header
    const head = [
        '<div class="bt-head">',
        '<span class="bt-c bt-rail"></span>',
        ...spec.columns.map((column, i) => {
            const sort = controls && isColumnSortable(column);
            // One control per column, showing the state it would move to next:
            // both directions at rest, then ascending, then descending.
            const sorter = sort
                ? `<span class="bt-sorters"><label class="bt-so bt-so-a" for="${prefix}-sa${i}" title="Sort ascending">${SORT_BOTH_SVG}</label><label class="bt-so bt-so-d" for="${prefix}-sd${i}" title="Sort descending">${CHEVRON_UP_SVG}</label><label class="bt-so bt-so-0" for="${prefix}-s0" title="Clear sort">${CHEVRON_DOWN_SVG}</label></span>`
                : '';
            // Rendered whether or not this column has a question: the block
            // reserves the same two lines in every header, which is what keeps
            // the titles on one baseline instead of each floating above a
            // description of its own length.
            const description = hasQuestions
                ? `<span class="bt-q">${escapeHtml(column.description ?? '')}</span>`
                : '';
            const full = column.description
                ? ` title="${escapeHtml(column.description)}"`
                : '';
            return `<span class="bt-c bt-h bt-h${i} bt-${columnAlign(column)} bt-hk-${column.type}${sort ? ' bt-sortable' : ''}${column.id === anchor?.id ? ' bt-anchor' : ''}"${full}><span class="bt-h-top"><span class="bt-h-label">${escapeHtml(column.header)}</span>${sorter}</span>${description}</span>`;
        }),
        hasActions ? '<span class="bt-c bt-acts-h"></span>' : '',
        '</div>',
    ]
        .filter(Boolean)
        .join('');

    // --- rows
    const body = rows
        .map((row, position) => {
            const rowRanks = ranks.get(row.id) ?? { asc: [], desc: [] };
            const orderVars = [
                ...rowRanks.asc.map((r, i) => `--o${i}:${r}`),
                ...rowRanks.desc.map((r, i) => `--p${i}:${r}`),
            ].join(';');
            const classes = ['bt-r', ...rowFilterClasses(row, spec, selectLabels)];
            if (row.status === 'error') classes.push('bt-r-err');

            const cells = spec.columns
                .map((column, i) => {
                    const anchorClass = column.id === anchor?.id ? ' bt-anchor' : '';
                    const sortable =
                        (spec.capabilities?.sortable ?? true) &&
                        isColumnSortable(column);
                    return `<span class="bt-c bt-${columnAlign(column)} bt-k-${column.type}${sortable ? ' bt-sortable' : ''}${anchorClass}" id="${escapeHtml(row.id)}/${escapeHtml(column.id)}">${renderCellValue(row.cells[column.id], column, cites)}</span>`;
                })
                .join('');

            const links = rowLinks.get(row.id) ?? null;
            const actions = hasActions
                ? `<span class="bt-c bt-acts">${renderActions(row, spec, links)}</span>`
                : '';

            return [
                `<details class="${classes.join(' ')}" id="${escapeHtml(row.id)}" style="${orderVars}">`,
                '<summary class="bt-row">',
                `<span class="bt-c bt-rail">${CHEVRON_SVG}</span>`,
                cells,
                actions,
                '</summary>',
                renderDetail(row, spec, links, cites),
                '</details>',
            ].join('');
        })
        .join('');

    const title = spec.title
        ? `<div class="bt-title-bar"><h1 class="bt-t">${escapeHtml(spec.title)}</h1>${
              spec.caption ? `<p class="bt-cap">${escapeHtml(spec.caption)}</p>` : ''
          }</div>`
        : '';

    const html = [
        `<section class="bt-wrap" style="--cols:${escapeHtml(template)};--n:${rows.length}">`,
        sortInputs.join(''),
        filterInputs,
        densityInputs,
        title,
        controls
            ? `<div class="bt-toolbar">${filterBar}<span class="bt-space"></span>${densityBar}</div>`
            : '',
        '<div class="bt-scroll">',
        '<div class="bt-body">',
        head,
        body,
        rows.length === 0 ? '<p class="bt-none">No rows.</p>' : '',
        '</div>',
        '</div>',
        renderBibliography(cites),
        `<footer class="bt-foot">${escapeHtml(footerParts.join(' · '))}</footer>`,
        '</section>',
    ]
        .filter(Boolean)
        .join('\n');

    // Without controls there are no radios to drive them, so the rules would
    // name ids and a toolbar that are not in the document. The defaults on
    // `.bt-body` already give the resting density.
    const dynamic = controls ? renderDynamicCss(spec, prefix, groups) : [];
    return {
        html: dynamic.length
            ? `${html}\n<style>\n${dynamic.join('\n')}\n</style>`
            : html,
        cssRuleCount: dynamic.length,
    };
}

/**
 * Whether this table's controls fit under the reader's stylesheet budget.
 *
 * The static sheet is a fixed cost; the per-table rules grow with the columns
 * and their categories, and a document over the budget is re-themed by a path
 * that flattens every colour it uses.
 */
function fitsBudget(
    spec: TableSpec,
    prefix: string,
    groups: FilterGroup[]
): boolean {
    const dynamic = renderDynamicCss(spec, prefix, groups).length;
    const fixed = countTopLevelCssRules(DOCUMENT_CSS + TABLE_CSS);
    return fixed + dynamic <= CSS_RULE_BUDGET;
}

/**
 * The cited sources, numbered as they were met.
 *
 * A table that carries citations has to carry what they refer to: the markers
 * are only useful next to a list that says what each one is, and the list is
 * what makes a saved table self-contained once it is away from the run that
 * produced it.
 */
function renderBibliography(cites: CitationNumbering): string {
    if (cites.cited.length === 0) return '';
    const items = cites.cited
        .map(({ marker, citation }) => {
            const label =
                citation?.formatted_citation ??
                citation?.display_name ??
                'Source unavailable';
            const href = cites.hrefFor(citation);
            const body = href
                ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
                : escapeHtml(label);
            return `<li id="bt-src-${marker}"><span class="bt-src-n">${marker}</span>${body}</li>`;
        })
        .join('');
    return `<section class="bt-srcs"><h2 class="bt-srcs-h">Sources</h2><ol class="bt-srcs-l">${items}</ol></section>`;
}

/**
 * The rules that depend on the spec: one per sort direction, one per filter
 * value. They live beside the table rather than in {@link TABLE_CSS} because
 * they name this table's own control ids.
 */
function renderDynamicCss(
    spec: TableSpec,
    prefix: string,
    groups: FilterGroup[]
): string[] {
    const rules: string[] = [];

    spec.columns.forEach((column, i) => {
        if (!isColumnSortable(column)) return;
        rules.push(
            `#${prefix}-sa${i}:checked ~ .bt-scroll .bt-r { order: var(--o${i}); }`,
            `#${prefix}-sd${i}:checked ~ .bt-scroll .bt-r { order: var(--p${i}); }`,
            // The active column keeps its control visible without a hover, and
            // the control offers the next state rather than the current one.
            `#${prefix}-sa${i}:checked ~ .bt-scroll .bt-h${i} .bt-sorters, #${prefix}-sd${i}:checked ~ .bt-scroll .bt-h${i} .bt-sorters { opacity: 1; color: var(--t-fg); }`,
            `#${prefix}-sa${i}:checked ~ .bt-scroll .bt-h${i} .bt-so-a, #${prefix}-sd${i}:checked ~ .bt-scroll .bt-h${i} .bt-so-a { display: none; }`,
            `#${prefix}-sa${i}:checked ~ .bt-scroll .bt-h${i} .bt-so-d { display: inline-flex; }`,
            `#${prefix}-sd${i}:checked ~ .bt-scroll .bt-h${i} .bt-so-0 { display: inline-flex; }`
        );
    });

    groups.forEach((group, g) => {
        group.classes.forEach((cls, index) => {
            rules.push(
                `#${prefix}-f${g}-${index + 1}:checked ~ .bt-scroll .bt-r:not(.${cls}) { display: none; }`,
                `#${prefix}-f${g}-${index + 1}:checked ~ .bt-toolbar .bt-fo${g}-${index + 1} { background: var(--t-sel); color: var(--t-fg); }`
            );
        });
        rules.push(
            `#${prefix}-f${g}-0:checked ~ .bt-toolbar .bt-fo${g}-0 { background: var(--t-sel); color: var(--t-fg); }`
        );
    });

    for (const [key, lines, titleLines, height] of [
        ['c', 2, 1, '3.7rem'],
        ['z', 3, 2, '5.5rem'],
        ['t', 6, 3, '9.5rem'],
    ] as const) {
        rules.push(
            `#${prefix}-d${key}:checked ~ .bt-scroll .bt-body { --lines: ${lines}; --title-lines: ${titleLines}; --row-h: ${height}; }`,
            key === 't'
                ? `#${prefix}-dt:checked ~ .bt-scroll .bt-venue { display: block; }`
                : '',
            key === 't'
                ? `#${prefix}-dt:checked ~ .bt-scroll .bt-authors + .bt-venue::before { content: none; }`
                : '',
            `#${prefix}-d${key}:checked ~ .bt-toolbar .bt-seg-${key} { background: var(--t-sel); color: var(--t-fg); }`
        );
    }

    return rules.filter(Boolean);
}

/**
 * The table stylesheet.
 *
 * Written against the same two constraints as `REPORT_CSS`: meaning is never
 * carried by `background-color` alone, because the reader's static theme drops
 * every background, and semantic colours are written at two-class specificity
 * so that theme's `body.force-static-theme *` rule cannot flatten them.
 */
export const TABLE_CSS = `
.bt-wrap {
  --t-fg: #16181d;
  --t-mut: #5b6472;
  --t-fade: #8b93a1;
  --t-line: #e4e7ec;
  --t-rule: #f0f2f5;
  --t-sel: #eef1f7;
  --t-accent: #2f5bd7;
  --t-warn: #a04a00;
  display: block;
  font-size: 14px;
  line-height: 1.45;
  color: var(--t-fg);
}
.bt-ctl { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.bt-title-bar { padding: 0 0 10px; border-bottom: 1px solid var(--t-line); }
.bt-t { font-size: 20px; line-height: 1.3; letter-spacing: -0.01em; margin: 0; }
.bt-cap { font-size: 13px; margin: 3px 0 0; color: var(--t-mut); }
.bt-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 0; border-bottom: 1px solid var(--t-line); }
.bt-space { flex: 1 1 auto; }
.bt-fg { display: inline-flex; align-items: center; gap: 3px; }
.bt-fg-h { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--t-fade); margin-right: 3px; }
.bt-fo { font-size: 12px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--t-line); color: var(--t-mut); cursor: pointer; }
.bt-fo:hover { border-color: var(--t-fade); }
.bt-seg { display: inline-flex; border: 1px solid var(--t-line); border-radius: 6px; overflow: hidden; }
.bt-seg-o { display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 20px; cursor: pointer; color: var(--t-fade); }
.bt-seg-o + .bt-seg-o { border-left: 1px solid var(--t-line); }
.bt-seg-o i { display: block; width: 12px; height: 11px;
  background-image: repeating-linear-gradient(to bottom, currentColor 0 1px, transparent 1px var(--step)); }
.bt-seg-c i { --step: 3px; }
.bt-seg-z i { --step: 4px; }
.bt-seg-t i { --step: 6px; }
.bt-scroll { overflow-x: auto; }
.bt-body { --lines: 3; --title-lines: 2; --row-h: 5.5rem;
  display: flex; flex-direction: column; min-width: min-content; }
.bt-head { display: grid; grid-template-columns: var(--cols); align-items: end;
  position: sticky; top: 0; z-index: 3; background: #fff;
  border-bottom: 1px solid var(--t-line); order: -1; }
.bt-c { padding: 8px 10px; min-width: 0; }
.bt-h { font-size: 14px; font-weight: 700; color: var(--t-fg); }
/* No item icon in this rendering, so a reference header needs no indent — the
   class is here so the two renderers stay comparable at a glance. */
.bt-hk-reference .bt-h-label { padding-left: 0; }
/* Full width, so the label lines up on the same edge the values do. */
.bt-h-top { position: relative; display: flex; align-items: center; gap: 3px;
  width: 100%; min-width: 0; }
.bt-end .bt-h-top { justify-content: flex-end; }
.bt-center .bt-h-top { justify-content: center; }
.bt-center { text-align: center; }
.bt-h-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A fixed two-line box, empty or not, so every header title shares a baseline.
   The full question is on the header's title attribute. */
.bt-q { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; height: 2.6em; font-size: 11px; font-weight: 400;
  line-height: 1.3; color: var(--t-fade); max-width: 22rem; }
/* Out of flow: in it the sorters kept their width while invisible, which
   pushed a right-aligned header label two controls' width in from the edge its
   values line up on. Absolute, they land in the cell's own padding, at the same
   place in every column. */
/* One control, beside its own label. Pinned to the cell's edge it drifted far
   from short headers and landed on top of narrow ones. Only the label for the
   next state shows; the values of a sortable column leave the same gutter, so
   the label still lines up with them. */
.bt-sorters { flex: 0 0 15px; display: inline-flex; justify-content: center;
  opacity: 0; transition: opacity 100ms ease; }
.bt-so { display: none; }
.bt-so-a { display: inline-flex; }
.bt-c.bt-sortable.bt-end:not(.bt-h) { padding-right: 25px; }
.bt-c.bt-sortable.bt-center:not(.bt-h) { padding-right: 25px; padding-left: 10px; }
.bt-h:hover .bt-sorters, .bt-h:focus-within .bt-sorters { opacity: 1; }
.bt-so { cursor: pointer; color: var(--t-fade); padding: 0; }
.bt-so:hover { color: var(--t-fg); }
.bt-gl { width: 11px; height: 11px; display: block; }
.bt-r { display: flex; flex-direction: column; border-bottom: 1px solid var(--t-rule); }
.bt-r > summary::marker { content: ''; }
.bt-r > summary::-webkit-details-marker { display: none; }
.bt-row { display: grid; grid-template-columns: var(--cols); align-items: start;
  min-height: var(--row-h); list-style: none; cursor: pointer; }
.bt-row:hover { background: #fafbfc; }
/* Aligned to the first line of the row rather than to the middle of the cell,
   so the glyph sits level with the title beside it. */
.bt-rail { display: flex; align-items: flex-start; padding-left: 12px; color: var(--t-fade); }
.bt-chev { width: 13px; height: 13px; display: block; transition: transform 120ms ease;
  margin-top: calc((1.45em - 13px) / 2); }
.bt-r[open] > .bt-row .bt-chev { transform: rotate(90deg); }
.bt-start { text-align: left; }
.bt-end { text-align: right; }
.bt-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.bt-unit { font-size: 11px; color: var(--t-mut); margin-left: 2px; }
.bt-clamp { display: -webkit-box; -webkit-line-clamp: var(--lines);
  -webkit-box-orient: vertical; overflow: hidden; color: var(--t-mut); }
.bt-ref { display: block; min-width: 0; }
.bt-title { display: -webkit-box; -webkit-line-clamp: var(--title-lines);
  -webkit-box-orient: vertical; overflow: hidden; font-weight: 550; }
/* Closer to the title than it was: the attribution is part of the row, not a
   footnote under it. */
.bt-sub { display: block; font-size: 13px; color: var(--t-fade);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Italic, because it is a publication name and not another author. The
   separator travels with the venue, so it goes when the venue takes its own
   line at the tallest row height and in the expanded row. */
.bt-venue { font-style: italic; }
.bt-authors + .bt-venue::before { content: ' · '; font-style: normal; }
.bt-d .bt-venue { display: block; }
.bt-d .bt-authors + .bt-venue::before { content: none; }
/* An annotation's comment is context, shown only in the expanded row. */
.bt-ann-comment { display: none; font-size: 13px; color: var(--t-mut); }
.bt-d .bt-ann-comment { display: block; white-space: normal; }
.bt-pill { display: inline-block; max-width: 100%; padding: 1px 8px; border-radius: 999px;
  font-size: 12px; line-height: 17px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; border: 1px solid transparent; }
/* Wraps rather than ellipsising: one truncated line of a DOI shows the prefix
   every row shares and none of what tells them apart. */
.bt-link { color: var(--t-accent); text-decoration: none; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: var(--lines); -webkit-box-orient: vertical;
  overflow: hidden; }
.bt-acts { display: flex; align-items: center; justify-content: flex-end; gap: 2px; padding-right: 12px; }
.bt-act { display: inline-flex; color: var(--t-fade); text-decoration: none; padding: 2px 3px; }
.bt-act:hover { color: var(--t-accent); }
.bt-act .bt-gl { width: 14px; height: 14px; }
.bt-d { padding: 4px 12px 14px 40px; background: #fbfcfd; }
.bt-d-fields { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: 5px 14px; margin: 0; }
.bt-d-fields dt { font-size: 12px; color: var(--t-fade); }
.bt-d-fields dd { margin: 0; min-width: 0; }
.bt-d .bt-clamp, .bt-d .bt-title { display: block; -webkit-line-clamp: unset; color: var(--t-fg); }
.bt-d .bt-sub { white-space: normal; }
.bt-d-extra { margin-top: 4px; }
.bt-d-list { margin: 4px 0 0; padding-left: 18px; }
.bt-d-actions { margin-top: 10px; }
/* The citation marker, as the chat renders it: a small raised number that says
   where a claim came from and opens the cited page. */
/* The citation marker, coloured the way the app colours it: green where it
   lands on a passage, blue for an external reference, grey for a plain item. */
.bt-cite { display: inline-block; min-width: 15px; padding: 0 4px; margin-left: 2px;
  border: 1px solid transparent; border-radius: 4px;
  font-size: 10px; line-height: 14px; font-weight: 600; text-align: center;
  text-decoration: none; vertical-align: 1px; cursor: pointer; }
.bt-cite--item { background: #f1f3f5; border-color: #e3e6ea; color: var(--t-mut); }
.bt-cite--locator { background: #e7f6ec; border-color: #cbe9d5; color: #1f7a3d; }
.bt-cite--external { background: #e8f1fd; border-color: #cfe0f7; color: #1a5aa8; }
.bt-cite:hover { filter: brightness(0.95); }
.bt-srcs { padding: 18px 0 0; border-top: 1px solid var(--t-line); margin-top: 14px; }
.bt-srcs-h { font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--t-fade); margin: 0 0 8px; font-weight: 650; }
.bt-srcs-l { list-style: none; margin: 0; padding: 0; }
.bt-srcs-l li { display: flex; gap: 8px; padding: 4px 0; font-size: 13px; }
.bt-src-n { flex: 0 0 auto; min-width: 16px; color: var(--t-fade);
  font-variant-numeric: tabular-nums; }
.bt-srcs-l a { color: var(--t-accent); text-decoration: none; }
.bt-srcs-l a:hover { text-decoration: underline; }
.bt-foot { padding: 8px 0 0; font-size: 12px; color: var(--t-fade); }
.bt-none { padding: 28px 0; text-align: center; color: var(--t-fade); }
.bt-wrap .bt-empty { color: var(--t-fade); }
.bt-wrap .bt-pending { color: var(--t-fade); font-style: italic; }
.bt-wrap .bt-err { color: var(--t-warn); }
.bt-wrap .bt-d-err { color: var(--t-warn); margin: 0 0 8px; font-size: 13px; }
.bt-wrap .bt-yes { color: #1f7a3d; }
.bt-wrap .bt-no { color: var(--t-fade); }
.bt-r.bt-r-err > .bt-row { box-shadow: inset 3px 0 0 #c0603f; }
.bt-pill.bt-pill--blue { background: #e8f1fd; color: #1a5aa8; border-color: #cfe0f7; }
.bt-pill.bt-pill--green { background: #e7f6ec; color: #1f7a3d; border-color: #cbe9d5; }
.bt-pill.bt-pill--purple { background: #f0ebfc; color: #5b3fb0; border-color: #ded2f6; }
.bt-pill.bt-pill--orange { background: #fdf0e3; color: #98590c; border-color: #f6dfc2; }
.bt-pill.bt-pill--red { background: #fdecec; color: #a83232; border-color: #f7d2d2; }
.bt-pill.bt-pill--yellow { background: #fbf3d9; color: #8a6a08; border-color: #f2e6bd; }
.bt-pill.bt-pill--gray { background: #f1f3f5; color: var(--t-mut); border-color: #e3e6ea; }
`.trim();

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/** Id of the `<script>` element that carries the embedded spec. */
export const TABLE_SPEC_SCRIPT_ID = 'beaver-table-spec';

/**
 * The spec as it is embedded in the document.
 *
 * Compact on purpose: the file already carries the rendered table, so the JSON
 * is machine state, and a large table would pay for every space twice — on disk
 * and in whatever later uploads the file.
 *
 * `<` is written as its JSON escape, which is what keeps the data from ending
 * the element it lives in: a cell containing `</script>` or `<!--` would
 * otherwise truncate the table's own state. `\u003c` decodes back to `<` under
 * `JSON.parse`, so the escape is lossless. Nothing else is escaped, and nothing
 * else should be: the reader below does `JSON.parse` and no unescaping, so any
 * other scheme would silently corrupt the values it was meant to protect.
 */
function serializeSpec(spec: TableSpec): string {
    return JSON.stringify(spec).replace(/</g, '\\u003c');
}

/**
 * A complete document, for a tab or a saved snapshot.
 *
 * The document is round-trippable: it embeds the spec it was rendered from, so
 * the stored `.html` is both a table anyone can read in a browser and the only
 * copy of the table's state Beaver needs to open it again. See
 * {@link parseTableDocument} for the way back in.
 */
export function buildTableDocument(
    spec: TableSpec,
    options: TableHtmlOptions = {}
): RenderedTable {
    const table = renderTableHtml(spec, options);
    // The file is the only copy of its state, so it says which format wrote it.
    // A spec that already names a version keeps it — as do `key` and `version`,
    // which belong to whatever stores the file rather than to the renderer.
    const stored: TableSpec =
        spec.spec_version == null
            ? { ...spec, spec_version: TABLE_SPEC_VERSION }
            : spec;

    const html = [
        '<!DOCTYPE html>',
        // Marks the document as one of ours, so a viewer can recognise it (and
        // read the format version off it) without parsing the spec.
        `<html lang="en" data-beaver-table="${escapeHtml(String(stored.spec_version))}">`,
        '<head>',
        '<meta charset="utf-8">',
        `<title>${escapeHtml(spec.title ?? 'Table')}</title>`,
        `<style>\n${DOCUMENT_CSS}\n${TABLE_CSS}\n</style>`,
        '</head>',
        '<body>',
        table.html,
        // Last in the body, after the table, and it has to stay there: snapshot
        // annotations anchor by character offset into the document's text, so
        // anything that could count as text must come after the content it
        // would otherwise displace. Tidying this into <head> — or anywhere
        // above the table — would silently break every annotation on every
        // stored table.
        `<script type="application/json" id="${TABLE_SPEC_SCRIPT_ID}">${serializeSpec(stored)}</script>`,
        '</body>',
        '</html>',
        '',
    ].join('\n');

    return {
        html,
        cssRuleCount:
            table.cssRuleCount + countTopLevelCssRules(DOCUMENT_CSS + TABLE_CSS),
    };
}

export type ParsedTableDocument =
    | { ok: true; spec: TableSpec }
    | {
          ok: false;
          reason: 'no_spec' | 'unsupported_version' | 'invalid';
          detail?: string;
          specVersion?: number;
      };

/**
 * The embedded spec, located by id. The document is our own deterministic
 * output, so the open tag is exact and the JSON body cannot contain `</script`
 * (see {@link serializeSpec}) — which is what makes the lazy match safe.
 */
const SPEC_SCRIPT_RE = new RegExp(
    `<script\\b[^>]*\\bid="${TABLE_SPEC_SCRIPT_ID}"[^>]*>([\\s\\S]*?)</script\\s*>`,
    'i'
);

/**
 * Reads a built document back into the spec it was rendered from.
 *
 * This is not a convenience. It is the proof that the stored file is a faithful
 * representation of the table rather than a picture of one: everything the
 * table knows about itself survives a save and a load, so a snapshot can be
 * re-opened, re-sorted, extended with a column and written back without the
 * round trip losing anything.
 *
 * Deliberately without `DOMParser`: this module has to stay usable from the
 * esbuild bundle and from a plain Node unit test, and neither reliably has one.
 * The version guard is {@link readSpec}'s, and `unsupported_version` survives
 * with the version it read — a caller must be able to open a newer file
 * read-only instead of writing back something lossy.
 */
export function parseTableDocument(html: string): ParsedTableDocument {
    const match = SPEC_SCRIPT_RE.exec(html);
    if (!match) return { ok: false, reason: 'no_spec' };

    let raw: unknown;
    try {
        raw = JSON.parse(match[1]);
    } catch (error) {
        return {
            ok: false,
            reason: 'invalid',
            detail: `embedded spec is not valid JSON: ${String(error)}`,
        };
    }

    const read = readSpec(raw);
    if (read.ok) return { ok: true, spec: read.spec };
    if (read.reason === 'unsupported_version') {
        return {
            ok: false,
            reason: 'unsupported_version',
            specVersion: read.specVersion,
        };
    }
    return { ok: false, reason: 'invalid', detail: read.detail };
}

/**
 * The table's sizes are in `rem`, so the root font size has to be pinned: left
 * to the viewer's 16px default every row height and clamp comes out about a
 * quarter taller than it was measured at, and the rows gape.
 */
const DOCUMENT_CSS = `
html { font-size: 14px; }
body { margin: 0; padding: 20px 24px 32px; background: #fff; color: #16181d;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
`.trim();
