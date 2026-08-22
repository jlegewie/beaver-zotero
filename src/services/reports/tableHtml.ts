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
 *   rank onto `order` in a flex column. Ascending is the rank; descending is the
 *   rank counted from the other end.
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
 * This module is free of Zotero APIs — callers pass prebuilt link URIs, exactly
 * as `reportHtml.ts` does.
 */

import {
    anchorColumn,
    cellSortKey,
    columnAlign,
    isColumnFilterable,
    isColumnSortable,
    rowActions,
    selectLabelsInColumn,
    sortRows,
    summarizeCoverage,
    type Cell,
    type Column,
    type Row,
    type RowRef,
    type TableSpec,
} from '@beaver/agent-core/layouts/table';
import { countTopLevelCssRules, escapeHtml } from './reportHtml';

export interface TableHtmlLinks {
    /** `zotero://select/...` for a row, or null when it cannot be revealed. */
    selectUri?: string | null;
    /** `zotero://open/...` for a row's file attachment, or null. */
    openUri?: string | null;
}

export interface TableHtmlOptions {
    /**
     * Emits the sort, filter and row-height controls. Off gives a plain
     * document sorted as the producer intended — the tier for a renderer that
     * strips form controls, and for a table small enough not to need them.
     */
    controls?: boolean;
    /** Per-row links. Rows it returns nothing for get no action links. */
    linksFor?: (ref: RowRef, row: Row) => TableHtmlLinks;
    /** Prefix for generated element ids, so two tables can share a document. */
    idPrefix?: string;
}

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
// Cells
// ---------------------------------------------------------------------------

const EMPTY_CELL = '—';

const SELECT_HUES = ['blue', 'green', 'purple', 'orange', 'red', 'yellow', 'gray'];

function selectHue(label: string, column: Column): string {
    const declared = column.options?.find((o) => o.label === label)?.color;
    if (declared && SELECT_HUES.includes(declared)) return declared;
    return 'gray';
}

/** Only `zotero:` and `https:` become links; anything else renders as text. */
function safeHref(uri: string | null | undefined): string | null {
    if (!uri) return null;
    return /^(zotero:\/\/|https:\/\/)/i.test(uri) ? uri : null;
}

function renderCellValue(cell: Cell | undefined, column: Column): string {
    if (cell?.status === 'pending') {
        return '<span class="bt-pending">Filling…</span>';
    }
    if (cell?.status === 'error') {
        return `<span class="bt-err">${escapeHtml(cell.error ?? 'Could not be extracted')}</span>`;
    }
    const value = cell?.value;
    if (!value) return `<span class="bt-empty">${EMPTY_CELL}</span>`;

    switch (value.kind) {
        case 'text':
            return `<span class="bt-clamp">${escapeHtml(value.text)}</span>`;

        case 'number':
            return `<span class="bt-num">${escapeHtml(
                value.display ?? value.value.toLocaleString()
            )}${column.unit && !value.display ? `<span class="bt-unit">${escapeHtml(column.unit)}</span>` : ''}</span>`;

        case 'date':
            return `<span class="bt-num">${escapeHtml(value.display ?? value.value)}</span>`;

        case 'boolean':
            // A check or a short dash — false must not look like empty.
            return value.value
                ? '<span class="bt-yes" title="yes">✓</span>'
                : '<span class="bt-no" title="no">–</span>';

        case 'select':
            return `<span class="bt-pill bt-pill--${selectHue(value.label, column)}">${escapeHtml(value.label)}</span>`;

        case 'reference': {
            const subtitle = value.subtitle
                ? `<span class="bt-sub">${escapeHtml(value.subtitle)}</span>`
                : '';
            return `<span class="bt-ref"><span class="bt-title">${escapeHtml(value.display_name)}</span>${subtitle}</span>`;
        }

        case 'link': {
            const href = safeHref(value.url);
            const label = escapeHtml(value.label ?? value.url);
            return href
                ? `<a class="bt-link" href="${escapeHtml(href)}" data-bt-external="1">${label}</a>`
                : `<span class="bt-empty">${label}</span>`;
        }

        default:
            return `<span class="bt-empty">${EMPTY_CELL}</span>`;
    }
}

// ---------------------------------------------------------------------------
// Ranks
// ---------------------------------------------------------------------------

function compareKeys(a: number | string | null, b: number | string | null): number {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b));
}

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
            const sign = direction === 'asc' ? 1 : -1;
            const ordered = keyed.slice().sort((a, b) => {
                if (a.key === null && b.key === null) return a.index - b.index;
                if (a.key === null) return 1;
                if (b.key === null) return -1;
                const cmp = compareKeys(a.key, b.key) * sign;
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

function filterGroups(spec: TableSpec, sortedRows: Row[]): FilterGroup[] {
    const groups: FilterGroup[] = [];
    for (const [index, column] of spec.columns.entries()) {
        if (!isColumnFilterable(column)) continue;

        if (column.type === 'select') {
            const labels = column.options?.length
                ? column.options.map((o) => o.label)
                : selectLabelsInColumn({ ...spec, rows: sortedRows }, column.id);
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
function rowFilterClasses(row: Row, spec: TableSpec): string[] {
    const classes: string[] = [];
    for (const [index, column] of spec.columns.entries()) {
        const value = row.cells[column.id]?.value;
        if (!value) continue;
        if (value.kind === 'select') {
            const labels = column.options?.length
                ? column.options.map((o) => o.label)
                : selectLabelsInColumn(spec, column.id);
            const at = labels.indexOf(value.label);
            if (at >= 0) classes.push(`bt-v${index}-${at}`);
        }
        if (value.kind === 'boolean') {
            classes.push(`bt-v${index}-${value.value ? 1 : 0}`);
        }
    }
    return classes;
}

function renderActions(row: Row, spec: TableSpec, links?: TableHtmlOptions['linksFor']): string {
    if (!links || !row.ref) return '';
    const verbs = rowActions(spec, row);
    if (verbs.length === 0) return '';
    const { selectUri, openUri } = links(row.ref, row) ?? {};

    const parts: string[] = [];
    const select = safeHref(selectUri);
    const open = safeHref(openUri);
    if (verbs.includes('reveal') && select) {
        parts.push(
            `<a class="bt-act" href="${escapeHtml(select)}" title="Reveal in library" aria-label="Reveal in library">↗</a>`
        );
    }
    if (verbs.includes('open') && open) {
        parts.push(
            `<a class="bt-act" href="${escapeHtml(open)}" title="Open" aria-label="Open">▤</a>`
        );
    }
    return parts.join('');
}

function renderDetail(row: Row, spec: TableSpec, links?: TableHtmlOptions['linksFor']): string {
    const fields = spec.columns
        .filter((column) => {
            const cell = row.cells[column.id];
            return !!cell?.value || !!cell?.details || !!cell?.status;
        })
        .map((column) => {
            const cell = row.cells[column.id];
            const details = cell?.details
                ? cell.details.kind === 'text'
                    ? `<div class="bt-d-extra">${escapeHtml(cell.details.text)}</div>`
                    : `<ul class="bt-d-list">${cell.details.items
                          .map((item) => `<li>${escapeHtml(item)}</li>`)
                          .join('')}</ul>`
                : '';
            return [
                `<dt>${escapeHtml(column.header)}</dt>`,
                `<dd>${renderCellValue(cell, column)}${details}</dd>`,
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
    const rows = sortRows(spec, spec.sort);
    const ranks = sortRanks(rows, spec.columns);
    const hasActions =
        !!options.linksFor && rows.some((row) => rowActions(spec, row).length > 0);

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

    const groups = controls ? filterGroups(spec, rows) : [];
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
            const sorter = sort
                ? `<span class="bt-sorters"><label class="bt-so bt-sa${i}" for="${prefix}-sa${i}" title="Sort ascending">▲</label><label class="bt-so bt-sd${i}" for="${prefix}-sd${i}" title="Sort descending">▼</label></span>`
                : '';
            const description = column.description
                ? `<span class="bt-q">${escapeHtml(column.description)}</span>`
                : '';
            return `<span class="bt-c bt-h bt-${columnAlign(column)}${column.id === anchor?.id ? ' bt-anchor' : ''}"><span class="bt-h-top"><span class="bt-h-label">${escapeHtml(column.header)}</span>${sorter}</span>${description}</span>`;
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
            const classes = ['bt-r', ...rowFilterClasses(row, spec)];
            if (row.status === 'error') classes.push('bt-r-err');

            const cells = spec.columns
                .map((column, i) => {
                    const anchorClass = column.id === anchor?.id ? ' bt-anchor' : '';
                    return `<span class="bt-c bt-${columnAlign(column)} bt-k-${column.type}${anchorClass}" id="${escapeHtml(row.id)}/${escapeHtml(column.id)}">${renderCellValue(row.cells[column.id], column)}</span>`;
                })
                .join('');

            const actions = hasActions
                ? `<span class="bt-c bt-acts">${renderActions(row, spec, options.linksFor)}</span>`
                : '';

            return [
                `<details class="${classes.join(' ')}" id="${escapeHtml(row.id)}" style="${orderVars}">`,
                '<summary class="bt-row">',
                `<span class="bt-c bt-rail"><span class="bt-idx">${position + 1}</span></span>`,
                cells,
                actions,
                '</summary>',
                renderDetail(row, spec, options.linksFor),
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
            `#${prefix}-sa${i}:checked ~ .bt-toolbar .bt-sa${i}, #${prefix}-sa${i}:checked ~ .bt-scroll .bt-sa${i} { color: var(--t-fg); }`,
            `#${prefix}-sd${i}:checked ~ .bt-scroll .bt-sd${i} { color: var(--t-fg); }`
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
        ['c', 1, 1, '2.2rem'],
        ['z', 3, 2, '5.5rem'],
        ['t', 6, 3, '9.5rem'],
    ] as const) {
        rules.push(
            `#${prefix}-d${key}:checked ~ .bt-scroll .bt-body { --lines: ${lines}; --title-lines: ${titleLines}; --row-h: ${height}; }`,
            // At one line the subtitle is what makes the row two, so it goes.
            key === 'c'
                ? `#${prefix}-dc:checked ~ .bt-scroll .bt-row .bt-sub { display: none; }`
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
.bt-h { font-size: 12px; font-weight: 650; color: var(--t-mut); }
.bt-h-top { display: flex; align-items: center; gap: 3px; min-width: 0; }
.bt-end .bt-h-top { flex-direction: row-reverse; }
.bt-h-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-q { display: block; font-size: 11px; font-weight: 400; line-height: 1.3;
  color: var(--t-fade); max-width: 22rem; }
.bt-sorters { display: inline-flex; gap: 1px; flex: 0 0 auto; }
.bt-so { font-size: 8px; line-height: 1; cursor: pointer; color: #c9cfd8; padding: 0 1px; }
.bt-so:hover { color: var(--t-fade); }
.bt-r { display: flex; flex-direction: column; border-bottom: 1px solid var(--t-rule); }
.bt-r > summary::marker { content: ''; }
.bt-r > summary::-webkit-details-marker { display: none; }
.bt-row { display: grid; grid-template-columns: var(--cols); align-items: start;
  min-height: var(--row-h); list-style: none; cursor: pointer; }
.bt-row:hover { background: #fafbfc; }
.bt-rail { display: flex; align-items: center; gap: 4px; padding-left: 12px; color: var(--t-fade); }
.bt-idx { font-size: 11px; font-variant-numeric: tabular-nums; }
.bt-rail::after { content: '›'; font-size: 13px; }
.bt-r[open] > .bt-row .bt-rail::after { content: '⌄'; }
.bt-start { text-align: left; }
.bt-end { text-align: right; }
.bt-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.bt-unit { font-size: 11px; color: var(--t-mut); margin-left: 2px; }
.bt-clamp { display: -webkit-box; -webkit-line-clamp: var(--lines);
  -webkit-box-orient: vertical; overflow: hidden; color: var(--t-mut); }
.bt-ref { display: block; min-width: 0; }
.bt-title { display: -webkit-box; -webkit-line-clamp: var(--title-lines);
  -webkit-box-orient: vertical; overflow: hidden; font-weight: 550; }
.bt-sub { display: block; font-size: 12px; color: var(--t-fade);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bt-pill { display: inline-block; max-width: 100%; padding: 1px 8px; border-radius: 999px;
  font-size: 12px; line-height: 17px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; border: 1px solid transparent; }
.bt-link { color: var(--t-accent); text-decoration: none; border-bottom: 1px solid var(--t-line);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: inline-block;
  max-width: 100%; vertical-align: bottom; }
.bt-acts { display: flex; align-items: center; justify-content: flex-end; gap: 2px; padding-right: 12px; }
.bt-act { color: var(--t-fade); text-decoration: none; font-size: 13px; padding: 2px 4px; }
.bt-act:hover { color: var(--t-accent); }
.bt-d { padding: 4px 12px 14px 40px; background: #fbfcfd; }
.bt-d-fields { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: 5px 14px; margin: 0; }
.bt-d-fields dt { font-size: 12px; color: var(--t-fade); }
.bt-d-fields dd { margin: 0; min-width: 0; }
.bt-d .bt-clamp, .bt-d .bt-title { display: block; -webkit-line-clamp: unset; color: var(--t-fg); }
.bt-d .bt-sub { white-space: normal; }
.bt-d-extra { margin-top: 4px; }
.bt-d-list { margin: 4px 0 0; padding-left: 18px; }
.bt-d-actions { margin-top: 10px; }
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

/** A complete document, for a tab or a saved snapshot. */
export function buildTableDocument(
    spec: TableSpec,
    options: TableHtmlOptions = {}
): RenderedTable {
    const table = renderTableHtml(spec, options);
    const html = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        `<title>${escapeHtml(spec.title ?? 'Table')}</title>`,
        `<style>\n${DOCUMENT_CSS}\n${TABLE_CSS}\n</style>`,
        '</head>',
        '<body>',
        table.html,
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
