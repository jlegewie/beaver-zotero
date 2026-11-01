/**
 * Renders a `TableSpec` as the table's static snapshot: a self-contained HTML
 * page.
 *
 * A stored table is `table.json` in the attachment's storage directory. This
 * page is what the store's renderer writes beside it, for everyone who opens
 * the attachment without Beaver (Zotero without the plugin, the web library,
 * the mobile apps, a browser) and for Zotero's full-text index. With Beaver
 * running, Zotero's reader never shows it: the Beaver tab replaces any reader
 * opened on a table.
 *
 * ## Portable, so static
 *
 * Zotero's snapshot reader loads documents under a CSP whose `script-src` has
 * no `'unsafe-inline'`, and other viewers strip or sandbox what they do not
 * know, so the page has no script and no controls that need one:
 *
 * - Rows are emitted already sorted by `spec.sort`.
 * - A row expands with `<details>` to its answers in full, their evidence
 *   (quote, table context, citation marker) and the row's actions.
 * - Citation markers and row verbs are plain `zotero://` links, and the cited
 *   works are listed under the table.
 * - A notice says the table was made with Beaver; its dismiss is a checkbox.
 *
 * What the page carries is chosen for size: every commit re-renders it, and
 * Zotero re-indexes and re-uploads it. A cell's reasoning stays in
 * `table.json` (the tab's inspector shows it), and evidence boxes, which only
 * a reader highlight uses, are never written.
 *
 * ## Layout
 *
 * A flex column of grid rows rather than a `<table>`, so a row and its
 * expansion are one `<details>` element. Alignment comes from every row sharing
 * one `grid-template-columns`.
 *
 * This module is free of Zotero APIs: callers pass prebuilt link URIs and a
 * library-scope resolver.
 *
 * ## The page is a rendering
 *
 * It carries no state of its own, only the hashes of the spec it shows and of
 * the whole `table.json` (see {@link buildTableDocument}). Rendering is a
 * **pure function of its inputs**: no clock, no random ids, no iteration over
 * anything whose order is not fixed by the spec, so the same spec always
 * produces the same bytes. The deliberate exceptions are the two options that
 * consult live Zotero state, `linksFor` and `citationScopeFor`, so two renders
 * of the same spec may differ in their links.
 */

import {
    anchorColumn,
    categoriesText,
    defaultHiddenColumnIds,
    columnAlign,
    evidenceHeading,
    isUncitedAnswer,
    isTitleAbstractOnly,
    rowActions,
    selectOption,
    sortRows,
    staleReason,
    stripCitationTags,
    summarizeCoverage,
    SELECT_COLORS,
    TABLE_SPEC_VERSION,
    type Cell,
    type Column,
    type Evidence,
    type Row,
    type RowAction,
    type RowFailure,
    type SelectOption,
    type TableSpec,
} from '@beaver/agent-core/layouts/table';
import { citationForEvidence } from '@beaver/agent-core/layouts/tableCitations';
import { baseCitationKey } from '@beaver/agent-core/citations/citationGrammar';
import { getCitationPages, type Citation } from '@beaver/agent-core/types/citations';
import { countTopLevelCssRules, escapeHtml } from '../../utils/html';

/**
 * The href behind each of a row's verbs, keyed by verb. A verb with no entry
 * gets no link; a verb that cannot be a link at all (`import` is a library
 * write) is never emitted here.
 */
export type TableHtmlLinks = Partial<Record<RowAction, string | null>>;

export interface TableHtmlOptions {
    /**
     * SHA-256 of the spec being rendered, written as a root attribute so the
     * snapshot names the table state it shows. See {@link renderedSpecHash}.
     */
    specSha256?: string;
    /**
     * SHA-256 of the whole committed `table.json`. Zotero syncs a snapshot
     * when its main file changes, so a commit that changes only the file's
     * creation marker must still change the HTML.
     */
    fileSha256?: string;
    /** Per-row links. Rows it returns nothing for get no action links. */
    linksFor?: (row: Row) => TableHtmlLinks;
    /**
     * The `zotero://` path scope for a cited item's library (`library` or
     * `groups/<groupID>`). This module has no Zotero, so the host supplies it —
     * the same `zoteroLinkScope` the row links use. Absent, every citation names
     * the personal library, which is all a caller with no Zotero can assume.
     */
    citationScopeFor?: (libraryId: number) => string;
}

/** Personal-library scope when the host does not supply {@link TableHtmlOptions.citationScopeFor}. */
const USER_LIBRARY_SCOPE = () => 'library';

export interface RenderedTable {
    /** The complete document. */
    html: string;
    /** Top-level rules in its stylesheet, for the reader's budget. */
    cssRuleCount: number;
}

// ---------------------------------------------------------------------------
// Widths
// ---------------------------------------------------------------------------

const RAIL_WIDTH = '2.6rem';
const FLEX_COLUMN_MIN = 'minmax(8rem, 1fr)';

/**
 * Per-type defaults. Text and reference columns share the width the reader
 * gives the table, so a typical comparison fits without scrolling sideways and
 * long answers wrap instead; their minimums only take over in a narrow pane or
 * a very wide table, where the frame scrolls. Everything else is sized to its
 * content.
 */
function columnWidth(column: Column, isAnchor: boolean): string {
    if (column.width != null)
        return column.width === 'fill' ? FLEX_COLUMN_MIN : `${column.width}px`;
    if (isAnchor) return 'minmax(11rem, 1.3fr)';
    switch (column.type) {
        case 'reference':
            return 'minmax(11rem, 1fr)';
        case 'date':
            return '7rem';
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

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/**
 * The pill colour of a select label's option. Checked against agent-core's
 * palette rather than a list restated here: a colour added there but missing
 * from a local copy renders as grey in every stored table.
 */
function selectHue(option: SelectOption | undefined): string {
    const declared = option?.color;
    return declared && (SELECT_COLORS as readonly string[]).includes(declared)
        ? declared
        : 'gray';
}

/** Only `zotero:` and `https:` become links; anything else renders as text. */
function safeHref(uri: string | null | undefined): string | null {
    if (!uri) return null;
    return /^(zotero:\/\/|https:\/\/)/i.test(uri) ? uri : null;
}

/** Why a cell is stale, as its marker's tooltip says it (the React grid says the same). */
const STALE_REASON_TEXT: Record<'question' | 'document', string> = {
    question: 'The question changed',
    document: "The paper's document changed",
};

/**
 * What stopped a row, in a few words: a row with nothing to read (no document
 * and no abstract) is told apart from one whose document could not be read.
 */
function rowFailureLabel(failure: RowFailure): string {
    return failure.code === 'no_source' ? 'Nothing to read' : 'Could not be read';
}

/**
 * One cell's value, followed by the markers of its evidence (given `cites`)
 * and its state: staleness with what changed, an answer from title and
 * abstract, and who edited it. The expanded row passes no `cites`, since its
 * markers follow their quotes.
 */
function renderCellValue(
    row: Row,
    cell: Cell | undefined,
    column: Column,
    cites?: CitationNumbering
): string {
    const html = renderCellValueInner(cell, column);
    if (!cell) return html;
    const markers = cites ? cites.markers(row, column.id) : '';
    const stale = staleReason(row, cell);
    const state = (text: string, className: string, title?: string): string =>
        `<span class="${className}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(text)}</span>`;
    const states = [
        stale ? state('Stale', 'bt-stale', STALE_REASON_TEXT[stale]) : '',
        isTitleAbstractOnly(cell) ? state('From title and abstract', 'bt-ta') : '',
        cell.outcome === 'cleared'
            ? state('Cleared by you', 'bt-by-user')
            : cell.provenance === 'user'
              ? state('Edited by you', 'bt-by-user')
              : '',
    ].filter(Boolean);
    return html + markers + (states.length ? `<small class="bt-cell-state"> · ${states.join(' · ')}</small>` : '');
}

/** The tooltip carrying a date's `display` in full, which the grid may cut short. */
function displayTitle(display: string | undefined): string {
    return display ? ` title="${escapeHtml(display)}"` : '';
}

function renderCellValueInner(cell: Cell | undefined, column: Column): string {
    if (cell?.outcome === 'failed') {
        return `<span class="bt-err">${escapeHtml(cell.error ?? 'Could not be answered')}</span>`;
    }
    // Nothing at all, rather than a placeholder glyph: a column of em dashes
    // reads as noise across a wide table, and the footer already counts what
    // is missing.
    const value = cell?.value;
    if (!value) return `<span class="bt-empty">${cell?.outcome === 'not_reported' ? 'Not reported' : ''}</span>`;

    switch (value.kind) {
        case 'text':
            return `<span class="bt-clamp">${escapeHtml(stripCitationTags(value.text))}</span>`;


        case 'date':
            return `<span class="bt-num"${displayTitle(value.display)}>${escapeHtml(value.display ?? value.value)}</span>`;

        case 'boolean':
            // A check for yes and the word in muted text for no: a blank no
            // could not be told from a cell that was never answered.
            return value.value
                ? '<span class="bt-yes" title="yes">✓</span>'
                : '<span class="bt-no">No</span>';

        case 'select': {
            const option = selectOption(column, value.label);
            const title = option?.description ? ` title="${escapeHtml(option.description)}"` : '';
            return `<span class="bt-pill bt-pill--${selectHue(option)}"${title}>${escapeHtml(value.label)}</span>`;
        }

        case 'reference': {
            const authors = value.subtitle
                ? `<span class="bt-authors">${escapeHtml(value.subtitle)}</span>`
                : '';
            const venue = value.venue
                ? `<span class="bt-venue">${escapeHtml(value.venue)}</span>`
                : '';
            const meta =
                authors || venue ? `<span class="bt-sub">${authors}${venue}</span>` : '';
            return `<span class="bt-ref"><span class="bt-title">${escapeHtml(value.title ?? value.display_name)}</span>${meta}</span>`;
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

/** One cited work in the bibliography, with every citation that names it. */
interface CitedSource {
    marker: number;
    key: string;
    citations: Citation[];
}

/**
 * The work a citation belongs to: its owning item when there is one, else the
 * cited object itself. Passages from one paper's PDF and a citation of the
 * paper's own record therefore share a number, as they do in the chat's
 * sources list.
 */
function citationSourceKey(citation: Citation): string {
    const ref = citation.parent_ref ?? citation.resolved_ref ?? citation.requested_ref;
    return ref ? baseCitationKey(ref) : citation.citation_id;
}

/**
 * Numbers every cited source in the table and renders evidence as markers.
 *
 * A marker is a small number that says where an answer came from: a
 * `zotero://` link to the cited page, with the source and page as its native
 * tooltip. The passage itself is quoted beside the marker in the expanded row,
 * so it is written once rather than again in every tooltip.
 *
 * Numbers belong to sources, not to passages: every passage from one paper
 * carries that paper's number, and the bibliography lists each paper once.
 * They are assigned in document order, so the bibliography reads in the order
 * a person meets the sources.
 */
class CitationNumbering {
    private readonly sources = new Map<string, CitedSource>();
    private readonly scopeFor: (libraryId: number) => string;
    /** Every cited source, in the order its marker was assigned. */
    readonly cited: CitedSource[] = [];

    constructor(scopeFor: (libraryId: number) => string = USER_LIBRARY_SCOPE) {
        this.scopeFor = scopeFor;
    }

    /**
     * Attachment citations open their document; item citations reveal the item.
     * Shared with the bibliography so a marker and its entry always agree.
     */
    hrefFor(citation: Citation | undefined): string | null {
        const ref = citation?.resolved_ref ?? citation?.requested_ref;
        if (!ref || !('zotero_key' in ref) || !ref.zotero_key) return null;
        const scope = zoteroScopeOf(ref, this.scopeFor);
        if (citation?.citation_type === 'item') {
            return `zotero://select/${scope}/items/${ref.zotero_key}`;
        }
        const page = getCitationPages(citation)[0];
        const base = `zotero://open/${scope}/items/${ref.zotero_key}`;
        return page ? `${base}?page=${page}` : base;
    }

    /** Where a source's bibliography entry points: the cited work in the library. */
    revealHrefFor(source: CitedSource): string | null {
        for (const citation of source.citations) {
            const ref = citation.parent_ref ?? citation.resolved_ref ?? citation.requested_ref;
            if (ref && 'zotero_key' in ref && ref.zotero_key) {
                return `zotero://select/${zoteroScopeOf(ref, this.scopeFor)}/items/${ref.zotero_key}`;
            }
        }
        return null;
    }

    /** The file a source's passages were read from, when it is a Zotero attachment. */
    openHrefFor(source: CitedSource): { href: string; label: string } | null {
        for (const citation of source.citations) {
            if (citation.citation_type !== 'attachment') continue;
            const ref = citation.resolved_ref ?? citation.requested_ref;
            if (!ref || !('zotero_key' in ref) || !ref.zotero_key) continue;
            return {
                href: `zotero://open/${zoteroScopeOf(ref, this.scopeFor)}/items/${ref.zotero_key}`,
                label: (citation.content_kind ?? 'pdf') === 'pdf' ? 'Open PDF' : 'Open',
            };
        }
        return null;
    }

    private numberFor(citation: Citation): number {
        const sourceKey = citationSourceKey(citation);
        let source = this.sources.get(sourceKey);
        if (!source) {
            source = { marker: this.sources.size + 1, key: sourceKey, citations: [] };
            this.sources.set(sourceKey, source);
            this.cited.push(source);
        }
        if (!source.citations.some((known) => known.citation_id === citation.citation_id))
            source.citations.push(citation);
        return source.marker;
    }

    /** The markers of one cell's evidence, in order. */
    markers(row: Row, columnId: string): string {
        const evidence = row.cells[columnId]?.evidence ?? [];
        return evidence.map((entry) => this.markerFor(row, entry)).join('');
    }

    /** The marker of one evidence entry, or nothing when it names no source. */
    markerFor(row: Row, evidence: Evidence): string {
        const citation = citationForEvidence(row, evidence);
        if (!citation) return '';
        const marker = this.numberFor(citation);
        const href = this.hrefFor(citation);
        const title = citationTitle(citation);
        const attrs = `class="bt-cite bt-cite--${citationTone(citation)}"${
            title ? ` title="${escapeHtml(title)}"` : ''
        }`;
        return href
            ? `<a ${attrs} href="${escapeHtml(href)}">${marker}</a>`
            : `<span ${attrs}>${marker}</span>`;
    }
}

/**
 * The `zotero://` scope a reference names. `library_ref` is the identity and
 * names its scope without any lookup (`u` → `library`, `g<id>` → `groups/<id>`),
 * which is what a table moved from another device carries; only a reference
 * without one falls back to resolving its rowid.
 */
export function zoteroScopeOf(
    ref: { library_id?: number; library_ref?: string },
    scopeFor: (libraryId: number) => string = USER_LIBRARY_SCOPE
): string {
    if (ref.library_ref === 'u') return 'library';
    const group = /^g([1-9][0-9]*)$/.exec(ref.library_ref ?? '');
    if (group) return `groups/${group[1]}`;
    return scopeFor(ref.library_id ?? 0);
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
    if (getCitationPages(citation).length || (ref && 'loc' in ref && ref.loc)) return 'locator';
    return 'item';
}

/**
 * A marker's tooltip: the source and the pages it cites, as the chat's card
 * names them. Sentence citations carry their pages in `locations`; the printed
 * label is what the reader shows, so it is what the tooltip names.
 */
function citationTitle(citation: Citation): string | undefined {
    const name = citation.display_name ?? citation.formatted_citation;
    const pages = getCitationPages(citation).map(
        (page) => citation.page_labels?.[page - 1] ?? String(page)
    );
    const locator = pages.length
        ? `${pages.length > 1 ? 'Pages' : 'Page'} ${pages.join(', ')}`
        : undefined;
    return [name, locator].filter(Boolean).join(' — ') || undefined;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

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

/**
 * The row's Reveal link, drawn at the edge of its anchor cell — the sticky
 * cell that never scrolls away. Every verb is also listed in the expanded
 * detail.
 */
function renderPrimaryAction(
    row: Row,
    spec: TableSpec,
    links: TableHtmlLinks | null
): string {
    if (!links || !rowActions(spec, row).includes('reveal')) return '';
    const link = ACTION_LINKS.reveal!;
    const href = safeHref(links.reveal);
    if (!href) return '';
    return `<a class="bt-act bt-ref-act" href="${escapeHtml(href)}" title="${link.label}" aria-label="${link.label}">${link.glyph}</a>`;
}

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

/**
 * One evidence entry in the expanded row: the table context of a passage cited
 * from a table (its caption and header rows) in small grey type, then the
 * quote and its marker.
 */
function renderEvidenceLine(evidence: Evidence, marker: string): string {
    const quote = evidence.quote.replace(/\s+/g, ' ').trim();
    const context = evidence.context
        ? `<span class="bt-ev-ctx">${escapeHtml(evidence.context)}</span>`
        : '';
    return `<li>${context}“${escapeHtml(quote)}”${marker}</li>`;
}

/**
 * A row's expansion: each answer in full with its evidence, any failure, and
 * every row verb. A cell's reasoning is not part of the page (see the module
 * comment).
 */
function renderDetail(
    row: Row,
    spec: TableSpec,
    links: TableHtmlLinks | null,
    cites: CitationNumbering
): string {
    const fields = spec.columns
        .filter((column) => !!row.cells[column.id])
        .map((column) => {
            const cell = row.cells[column.id];
            // The answer's evidence sits under it, headed by the cell's
            // outcome, each passage followed by its marker; an answer read
            // from a document that cites nothing says so.
            const evidence = cell?.evidence?.length
                ? `<div class="bt-d-h">${evidenceHeading(cell)}</div><ul class="bt-d-list">${cell.evidence
                      .map((entry) => renderEvidenceLine(entry, cites.markerFor(row, entry)))
                      .join('')}</ul>`
                : isUncitedAnswer(cell)
                  ? '<div class="bt-d-uncited">No passage cited</div>'
                  : '';
            return [
                `<dt>${escapeHtml(column.header)}</dt>`,
                `<dd>${renderCellValue(row, cell, column)}${evidence}</dd>`,
            ].join('');
        })
        .join('');

    const error = row.failure
        ? `<p class="bt-d-err"><strong>${escapeHtml(rowFailureLabel(row.failure))}.</strong> ${escapeHtml(row.failure.message)}</p>`
        : '';

    const actions = renderActions(row, spec, links);
    return `<div class="bt-d">${error}<dl class="bt-d-fields">${fields}</dl>${
        actions ? `<div class="bt-d-actions">${actions}</div>` : ''
    }</div>`;
}

/** The table as a fragment of the page: title, grid, codebook, sources, footer. */
export function renderTableHtml(spec: TableSpec, options: TableHtmlOptions = {}): string {
    const anchor = anchorColumn(spec);
    const cites = new CitationNumbering(options.citationScopeFor);
    const rows = sortRows(spec, spec.sort);

    // System columns stay out of the grid; a static document has no toggle,
    // so the expanded row is where they show.
    const hidden = new Set(defaultHiddenColumnIds(spec));
    const gridColumns = spec.columns.filter((c) => !hidden.has(c.id) || c.id === anchor?.id);
    const hasQuestions = gridColumns.some((c) => !!c.description);

    const template = [
        RAIL_WIDTH,
        ...gridColumns.map((c) => columnWidth(c, c.id === anchor?.id)),
    ].join(' ');

    const coverage = summarizeCoverage(spec, rows);
    const footerParts = [`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`];
    if (coverage.notReported > 0)
        footerParts.push(`${coverage.notReported} not reported`);
    if (coverage.error > 0) footerParts.push(`${coverage.error} failed`);
    if (coverage.titleAbstractOnly > 0)
        footerParts.push(`${coverage.titleAbstractOnly} from title and abstract`);
    if (coverage.errorRows > 0)
        footerParts.push(
            `${coverage.errorRows} ${coverage.errorRows === 1 ? 'paper' : 'papers'} could not be read`
        );

    const head = [
        '<div class="bt-head">',
        '<span class="bt-c bt-rail"></span>',
        ...gridColumns.map((column) => {
            // Rendered whether or not this column has a question: the block
            // reserves the same two lines in every header, which is what keeps
            // the titles on one baseline instead of each floating above a
            // description of its own length.
            const description = hasQuestions
                ? `<span class="bt-q">${escapeHtml(column.description ?? '')}</span>`
                : '';
            // The question in full, then the categories' definitions.
            const hover = [column.description, categoriesText(column)].filter(Boolean).join('\n\n');
            const full = hover ? ` title="${escapeHtml(hover)}"` : '';
            return `<span class="bt-c bt-h bt-${columnAlign(column)} bt-hk-${column.type}${column.id === anchor?.id ? ' bt-anchor' : ''}"${full}><span class="bt-h-label">${escapeHtml(column.header)}</span>${description}</span>`;
        }),
        '</div>',
    ].join('');

    const body = rows
        .map((row) => {
            const links = resolveRowLinks(row, options.linksFor);
            const cells = gridColumns
                .map((column) => {
                    const isAnchor = column.id === anchor?.id;
                    // The anchor cell carries the row's Reveal link.
                    const action = isAnchor ? renderPrimaryAction(row, spec, links) : '';
                    return `<span class="bt-c bt-${columnAlign(column)} bt-k-${column.type}${isAnchor ? ' bt-anchor' : ''}" id="${escapeHtml(row.id)}/${escapeHtml(column.id)}">${renderCellValue(row, row.cells[column.id], column, cites)}${action}</span>`;
                })
                .join('');

            return [
                `<details class="bt-r${row.failure ? ' bt-r-err' : ''}" id="${escapeHtml(row.id)}">`,
                '<summary class="bt-row">',
                `<span class="bt-c bt-rail">${CHEVRON_SVG}</span>`,
                cells,
                '</summary>',
                renderDetail(row, spec, links, cites),
                '</details>',
            ].join('');
        })
        .join('');

    const title = spec.title
        ? `<div class="bt-title-bar"><h1 class="bt-t">${escapeHtml(spec.title)}</h1>${
              spec.description ? `<p class="bt-cap">${escapeHtml(spec.description)}</p>` : ''
          }</div>`
        : '';

    return [
        `<section class="bt-wrap" style="--cols:${escapeHtml(template)}">`,
        title,
        '<div class="bt-scroll">',
        '<div class="bt-body">',
        head,
        body,
        rows.length === 0 ? '<p class="bt-none">No rows.</p>' : '',
        '</div>',
        '</div>',
        renderCodebook(spec),
        renderBibliography(cites),
        `<footer class="bt-foot">${escapeHtml(footerParts.join(' · '))}</footer>`,
        '</section>',
    ]
        .filter(Boolean)
        .join('\n');
}

/**
 * How the table's categories were coded: each select column with a defined
 * category, its question and every category with its definition. Collapsed
 * under the table, and plain `<details>`, so the document needs no script.
 */
function renderCodebook(spec: TableSpec): string {
    const coded = spec.columns.filter(
        (column) => column.type === 'select' && column.options?.some((option) => option.description),
    );
    if (coded.length === 0) return '';
    const columns = coded
        .map((column) => {
            const question = column.description
                ? `<p class="bt-cb-q">${escapeHtml(column.description)}</p>`
                : '';
            const options = (column.options ?? [])
                .map(
                    (option) =>
                        `<li><span class="bt-cb-l">${escapeHtml(option.label)}</span>${
                            option.description ? ` — ${escapeHtml(option.description)}` : ''
                        }</li>`,
                )
                .join('');
            return `<div class="bt-cb-c"><h3 class="bt-cb-h">${escapeHtml(column.header)}</h3>${question}<ul class="bt-cb-o">${options}</ul></div>`;
        })
        .join('');
    return `<details class="bt-codebook"><summary class="bt-codebook-h">Codebook</summary>${columns}</details>`;
}

/**
 * The cited sources, numbered as they were met, one entry per work.
 *
 * A table that carries citations has to carry what they refer to: the markers
 * are only useful next to a list that says what each one is, and the list is
 * what makes a saved table self-contained once it is away from the run that
 * produced it.
 *
 * Like the chat's sources list, an entry reveals the work in the library and
 * offers the file its passages were read from as a separate link; a marker is
 * what goes to a specific passage.
 */
function renderBibliography(cites: CitationNumbering): string {
    if (cites.cited.length === 0) return '';
    const items = cites.cited
        .map((source) => {
            const citation = source.citations[0];
            const label =
                citation?.formatted_citation ??
                citation?.display_name ??
                'Source unavailable';
            const reveal = cites.revealHrefFor(source);
            const open = cites.openHrefFor(source);
            const body = reveal
                ? `<a href="${escapeHtml(reveal)}" title="Show in library">${escapeHtml(label)}</a>`
                : escapeHtml(label);
            const openLink = open
                ? ` <a class="bt-src-open" href="${escapeHtml(open.href)}">${escapeHtml(open.label)}</a>`
                : '';
            return `<li id="bt-src-${source.marker}"><span class="bt-src-n">${source.marker}</span><span class="bt-src-b">${body}${openLink}</span></li>`;
        })
        .join('');
    return `<section class="bt-srcs"><h2 class="bt-srcs-h">Sources</h2><ol class="bt-srcs-l">${items}</ol></section>`;
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
/* A size container, so an expanded row can be exactly as wide as the visible
   part of a table that scrolls sideways. The gradients are the usual
   scroll-shadow pair: a shadow at whichever edge has more columns past it,
   covered by a scrolling white mask at the edge the table has reached. Overlay
   scrollbars show nothing at rest, so without them a narrow frame hides its
   last columns without a hint. */
.bt-scroll { overflow-x: auto; container-type: inline-size;
  background:
    linear-gradient(to right, #fff 40%, rgba(255, 255, 255, 0)) left center / 28px 100% no-repeat local,
    linear-gradient(to left, #fff 40%, rgba(255, 255, 255, 0)) right center / 28px 100% no-repeat local,
    radial-gradient(farthest-side at 0 50%, rgba(0, 0, 0, 0.24), rgba(0, 0, 0, 0)) left center / 14px 100% no-repeat scroll,
    radial-gradient(farthest-side at 100% 50%, rgba(0, 0, 0, 0.24), rgba(0, 0, 0, 0)) right center / 14px 100% no-repeat scroll; }
/* Answers show up to eight lines in the grid; the expanded row has them whole. */
.bt-body { --lines: 8; --title-lines: 3;
  display: flex; flex-direction: column; min-width: min-content; }
.bt-head { display: grid; grid-template-columns: var(--cols); align-items: end;
  position: sticky; top: 0; z-index: 3; background: #fff;
  border-bottom: 1px solid var(--t-line); }
.bt-c { padding: 8px 10px; min-width: 0; }
.bt-h { font-size: 14px; font-weight: 700; color: var(--t-fg); }
.bt-center { text-align: center; }
/* Wraps to a second line before it truncates: in a table that fits the frame
   the columns are narrow, and a header cut to "Research qu…" names nothing. */
.bt-h-label { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; overflow-wrap: anywhere; }
/* A fixed two-line box, empty or not, so every header title shares a baseline.
   The full question is on the header's title attribute. */
.bt-q { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; height: 2.6em; font-size: 11px; font-weight: 400;
  line-height: 1.3; color: var(--t-fade); max-width: 22rem; }
.bt-gl { width: 11px; height: 11px; display: block; }
.bt-r { display: block; border-bottom: 1px solid var(--t-rule); }
.bt-r > summary::marker { content: ''; }
.bt-r > summary::-webkit-details-marker { display: none; }
.bt-row { display: grid; grid-template-columns: var(--cols); align-items: start;
  list-style: none; cursor: pointer; }
.bt-row:hover { background: #fafbfc; }
/* Aligned to the first line of the row rather than to the middle of the cell,
   so the glyph sits level with the title beside it. */
.bt-rail { display: flex; align-items: flex-start; padding-left: 12px; color: var(--t-fade); }
.bt-chev { width: 13px; height: 13px; display: block; transition: transform 120ms ease;
  margin-top: calc((1.45em - 13px) / 2); }
.bt-r[open] > .bt-row .bt-chev { transform: rotate(90deg); }
.bt-start { text-align: left; }
.bt-end { text-align: right; }
/* A long display ellipsises to one line in the grid, whole in its tooltip, and
   wraps in full in the expanded row. */
.bt-num { display: inline-block; max-width: 100%; vertical-align: top; overflow: hidden;
  text-overflow: ellipsis; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bt-d .bt-num { display: inline; white-space: normal; }
.bt-clamp { display: -webkit-box; -webkit-line-clamp: var(--lines);
  -webkit-box-orient: vertical; overflow: hidden; color: var(--t-mut); }
.bt-ref { display: block; min-width: 0; }
.bt-title { display: -webkit-box; -webkit-line-clamp: var(--title-lines);
  -webkit-box-orient: vertical; overflow: hidden; font-weight: 550; }
.bt-sub { display: block; font-size: 13px; color: var(--t-fade);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Italic, because it is a publication name and not another author; on a line
   of its own under the authors. */
.bt-venue { display: block; font-style: italic; }
.bt-pill { display: inline-block; max-width: 100%; padding: 1px 8px; border-radius: 999px;
  font-size: 12px; line-height: 17px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; border: 1px solid transparent; }
/* Wraps rather than ellipsising: one truncated line of a DOI shows the prefix
   every row shares and none of what tells them apart. */
.bt-link { color: var(--t-accent); text-decoration: none; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: var(--lines); -webkit-box-orient: vertical;
  overflow: hidden; }
.bt-act { display: inline-flex; color: var(--t-fade); text-decoration: none; padding: 2px 3px; }
/* The primary verb sits at the edge of the anchor cell; the expanded row lists
   every verb. */
.bt-anchor { position: relative; padding-right: 30px; }
.bt-ref-act { position: absolute; top: 6px; right: 6px; }
.bt-act:hover { color: var(--t-accent); }
.bt-act .bt-gl { width: 14px; height: 14px; }
/* Pinned to the visible width: the row it expands may be wider than the
   frame, and its text should not need a sideways scroll to read. */
.bt-d { position: sticky; left: 0; box-sizing: border-box; width: 100cqi;
  padding: 4px 12px 14px 40px; background: #fbfcfd; }
.bt-d-fields { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: 5px 14px; margin: 0; }
.bt-d-fields dt { font-size: 12px; color: var(--t-fade); }
.bt-d-fields dd { margin: 0; min-width: 0; }
.bt-d .bt-clamp, .bt-d .bt-title { display: block; -webkit-line-clamp: unset; color: var(--t-fg); }
.bt-d .bt-sub { white-space: normal; }
.bt-d-list { margin: 4px 0 0; padding-left: 18px; }
.bt-d-h { margin-top: 4px; font-size: 12px; color: var(--t-fade); }
.bt-d-uncited { margin-top: 4px; font-size: 12px; color: var(--t-fade); }
.bt-ev-ctx { display: block; font-size: 12px; color: var(--t-fade); }
.bt-d-actions { margin-top: 10px; }
/* The citation marker, coloured the way the app colours it: green where it
   lands on a passage, blue for an external reference, grey for a plain item. */
.bt-cite { display: inline-block; min-width: 15px; padding: 0 4px; margin-left: 2px;
  border: 1px solid transparent; border-radius: 4px;
  font-size: 10px; line-height: 14px; font-weight: 600; text-align: center;
  text-decoration: none; vertical-align: 1px; }
.bt-cite--item { background: #f1f3f5; border-color: #e3e6ea; color: var(--t-mut); }
.bt-cite--locator { background: #e7f6ec; border-color: #cbe9d5; color: #1f7a3d; }
.bt-cite--external { background: #e8f1fd; border-color: #cfe0f7; color: #1a5aa8; }
.bt-srcs { padding: 18px 0 0; border-top: 1px solid var(--t-line); margin-top: 14px; }
.bt-srcs-h { font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--t-fade); margin: 0 0 8px; font-weight: 650; }
.bt-srcs-l { list-style: none; margin: 0; padding: 0; }
.bt-srcs-l li { display: flex; gap: 8px; padding: 4px 0; font-size: 13px; }
.bt-src-n { flex: 0 0 auto; min-width: 16px; color: var(--t-fade);
  font-variant-numeric: tabular-nums; }
.bt-srcs-l a { color: var(--t-accent); text-decoration: none; }
.bt-srcs-l a:hover { text-decoration: underline; }
.bt-srcs-l .bt-src-open { margin-left: 8px; font-size: 12px; white-space: nowrap; color: var(--t-mut); }
.bt-srcs-l .bt-src-open:hover { color: var(--t-accent); }
.bt-codebook { padding: 14px 0 0; border-top: 1px solid var(--t-line); margin-top: 14px; font-size: 13px; }
.bt-codebook-h { cursor: pointer; font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--t-fade); font-weight: 650; }
.bt-cb-c { margin: 10px 0 0; }
.bt-cb-h { font-size: 13px; font-weight: 650; margin: 0; }
.bt-cb-q { margin: 2px 0 0; color: var(--t-mut); }
.bt-cb-o { margin: 4px 0 0; padding-left: 18px; }
.bt-cb-l { font-weight: 600; }
.bt-foot { padding: 8px 0 0; font-size: 12px; color: var(--t-fade); }
.bt-none { padding: 28px 0; text-align: center; color: var(--t-fade); }
.bt-wrap .bt-empty { color: var(--t-fade); }
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

/** Root attribute naming the SHA-256 of the spec the snapshot renders. */
export const TABLE_SPEC_HASH_ATTRIBUTE = 'data-beaver-spec-sha256';

/** Root attribute naming the SHA-256 of the `table.json` the snapshot was rendered from. */
export const TABLE_FILE_HASH_ATTRIBUTE = 'data-beaver-file-sha256';

/** Where the notice below sends a reader who does not have the plugin. */
export const BEAVER_HOME_URL = 'https://www.beaverapp.ai';

/** The checkbox that dismisses the notice; one notice per document, so one id. */
const NOTICE_DISMISS_ID = 'beaver-table-notice-dismiss';

/**
 * The notice every viewer of the page gets. Zotero with Beaver shows the table
 * in the Beaver tab instead, so whoever reads the page almost always lacks the
 * plugin. The page reads and expands anywhere, but the table's own surface
 * (verification in the reader, editing, filling) needs Beaver, and Zotero's
 * snapshot reader leaves the page's `zotero:` links inert. The notice says one
 * thing, so that it can be read at a glance and stay true as the table gains
 * features.
 *
 * It is dismissible with a checkbox and its label, which needs no script.
 * Emitted only by {@link buildTableDocument}.
 */
function renderPluginNotice(): string {
    return [
        `<input type="checkbox" id="${NOTICE_DISMISS_ID}" class="bt-ctl">`,
        '<aside class="bt-nb">',
        '<span class="bt-nb-b">',
        '<strong>This table was created with Beaver.</strong> ',
        'Install Beaver for Zotero for full table support.',
        '</span>',
        `<a class="bt-nb-a" href="${BEAVER_HOME_URL}" target="_blank" rel="noopener noreferrer">Get Beaver</a>`,
        `<label class="bt-nb-x" for="${NOTICE_DISMISS_ID}" title="Dismiss" aria-label="Dismiss">×</label>`,
        '</aside>',
    ].join('');
}

/**
 * The complete page.
 *
 * The page is a rendering, not the table: `table.json` is the table. The root
 * names the hash of the spec it shows and the digest of the whole `table.json`
 * it was rendered from: the first tells a current page from one a render
 * behind, and the second makes every commit change the file Zotero syncs by,
 * even one that leaves the spec as it was.
 */
export function buildTableDocument(
    spec: TableSpec,
    options: TableHtmlOptions = {}
): RenderedTable {
    const digest = (attribute: string, value: string | undefined) =>
        value && /^[a-f0-9]{64}$/.test(value) ? ` ${attribute}="${value}"` : '';
    const hash = digest(TABLE_SPEC_HASH_ATTRIBUTE, options.specSha256)
        + digest(TABLE_FILE_HASH_ATTRIBUTE, options.fileSha256);

    const html = [
        '<!DOCTYPE html>',
        // Marks the document as one of ours, and the format it renders, so a
        // viewer can recognise it without reading anything else. A spec built
        // in this process names no version and is this build's format.
        `<html lang="en" data-beaver-table="${escapeHtml(String(spec.spec_version ?? TABLE_SPEC_VERSION))}"${hash}>`,
        '<head>',
        '<meta charset="utf-8">',
        `<title>${escapeHtml(spec.title ?? 'Table')}</title>`,
        `<style>\n${DOCUMENT_CSS}\n${TABLE_CSS}\n</style>`,
        '</head>',
        '<body>',
        // Above the table because that is where it is read, and part of every
        // render so that re-rendering the same spec still produces the same
        // bytes.
        renderPluginNotice(),
        renderTableHtml(spec, options),
        '</body>',
        '</html>',
        '',
    ].join('\n');

    return { html, cssRuleCount: countTopLevelCssRules(DOCUMENT_CSS + TABLE_CSS) };
}

/** The spec hash a rendered snapshot names, or null for one that names none. */
export function renderedSpecHash(html: string): string | null {
    const match = new RegExp(`<html\\b[^>]*\\b${TABLE_SPEC_HASH_ATTRIBUTE}="([a-f0-9]{64})"`).exec(html);
    return match ? match[1] : null;
}

/** The `table.json` digest a rendered snapshot names on its root element, or null. */
export function renderedFileHash(html: string): string | null {
    const match = new RegExp(`<html\\b[^>]*\\b${TABLE_FILE_HASH_ATTRIBUTE}="([a-f0-9]{64})"`).exec(html);
    return match ? match[1] : null;
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
/* The "made with Beaver" notice. Its meaning is carried by the border and the
   text rather than by the background, so it survives the reader's static theme. */
.bt-nb { display: flex; align-items: baseline; gap: 10px; margin: 0 0 14px;
  padding: 8px 12px; font-size: 12px; line-height: 1.45; color: #5b6472;
  border: 1px solid #dbe2f0; border-left: 3px solid #2f5bd7; border-radius: 6px;
  background: #f6f8fd; }
.bt-nb strong { color: #16181d; font-weight: 600; }
.bt-nb-b { flex: 1 1 auto; }
.bt-nb-a { flex: 0 0 auto; white-space: nowrap; font-weight: 600;
  color: #2f5bd7; text-decoration: none; }
.bt-nb-a:hover { text-decoration: underline; }
.bt-nb-x { flex: 0 0 auto; cursor: pointer; color: #8b93a1; font-size: 15px; line-height: 1; }
.bt-nb-x:hover { color: #5b6472; }
#${NOTICE_DISMISS_ID}:checked ~ .bt-nb { display: none; }
`.trim();
