/**
 * What the item-pane section for a stored table says, derived from numbers the
 * store already has.
 *
 * Split out of `tableItemPane.ts` because everything here is arithmetic and
 * string building over a {@link TableSummary} and a version log — no Zotero, no
 * DOM, no I/O. That is the part worth testing, and the part that must not throw
 * into Zotero's item pane, so it is the part that gets to be pure.
 *
 * The counts come from the tip entry of the version log, which carries the
 * `summarize()` of the spec that was written. Reading them from there is the
 * whole point: a table's spec is a megabyte of JSON embedded in an HTML file,
 * and the item pane must not parse it to say "12 rows". A table with no log —
 * one whose sidecar is gone — falls back to summarizing the spec, and a table
 * whose spec cannot be read renders nothing but its refusal.
 */

import type { TableSummary } from '@beaver/agent-core/layouts/tableMutations';
import type { TableVersionEntry } from '../services/artifacts/tableItemIdentity';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** Where the counts came from, so a caller can tell a fallback from the norm. */
export type TableSectionSource = 'history' | 'spec';

/**
 * A table that went backwards under this device, as the section needs it —
 * structurally the store's `TableSyncConflict`, restated here so this module
 * stays free of everything but arithmetic and strings.
 */
export interface TableSectionConflict {
    /** `behind`: a lower version. `diverged`: the same number, other content. */
    reason: 'behind' | 'diverged';
    /** The version the table is at now. */
    documentVersion: number;
    /** The version this device wrote, and lost. */
    shadowVersion: number;
    /** Whether the retained spec is still here to be restored. */
    restorable: boolean;
}

export interface TableSectionInput {
    /** `summarize()` of the current spec, from the log tip or computed. */
    summary: TableSummary | null;
    source: TableSectionSource | null;
    /** The version the table is at, or null when nothing says. */
    version: number | null;
    /** The log as stored, oldest first. Empty when there is none. */
    history: TableVersionEntry[];
    /**
     * Column headers by column id, when the caller happens to hold the spec.
     * The log's summary does not carry them, so a distribution read from the
     * log is labelled with a humanized column id instead.
     */
    headers?: Record<string, string>;
    /**
     * When each annotation's position was captured — Zotero's `dateAdded`, in
     * either SQL UTC or ISO form. One entry per annotation on the item.
     */
    annotationDates?: (string | null | undefined)[];
    /**
     * Set when this device's copy of the table was replaced by another
     * device's. Absent on every ordinary table, which is the point: this line
     * only appears when something was actually lost.
     */
    conflict?: TableSectionConflict | null;
}

export interface TableSectionDistributionEntry {
    label: string;
    count: number;
}

export interface TableSectionDistribution {
    columnId: string;
    /** The column header if known, else the column id made readable. */
    label: string;
    /** Set when the column plays a known part in a workflow. */
    role?: string;
    entries: TableSectionDistributionEntry[];
    /** Labels not shown because the list was capped. */
    truncated: number;
}

/** Everything the section renders, and everything the dev endpoint reports. */
export interface TableSectionFields {
    source: TableSectionSource | null;
    rows: number;
    columns: number;
    /** `rows × columns` — the denominator for {@link filled}. */
    cells: number;
    filled: number;
    unsure: number;
    unsourced: number;
    stale: number;
    version: number | null;
    /** The oldest version still in the log, or null when the log is empty. */
    oldestVersion: number | null;
    /** True when retention has dropped versions below {@link oldestVersion}. */
    historyTruncated: boolean;
    /** ISO timestamp of the most recent write the log knows about. */
    lastWriteAt: string | null;
    annotations: number;
    /** Annotations whose position was captured before the most recent write. */
    annotationsBeforeLastWrite: number;
    annotationWarning: boolean;
    distributions: TableSectionDistribution[];
    /** "12 rows × 7 columns". Empty only when there is nothing to count. */
    dimensionsLine: string;
    /** "58 of 84 cells filled", or empty when there are no cells. */
    coverageLine: string;
    /** "3 unsure · 1 unsourced · 2 stale", or empty when nothing is flagged. */
    flagsLine: string;
    /** "Version 12 · history goes back to v7", or empty when unknown. */
    versionLine: string;
    /** The collapsed-header summary. */
    headerSummary: string;
    /** The annotation caveat, or null when it does not apply. */
    warning: string | null;
    /** The sync conflict, or null when the table is not in that state. */
    conflict: TableSectionConflict | null;
    /** What the section says about it, or null when there is nothing to say. */
    conflictLine: string | null;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * How many distributions the section shows, and how many labels each gets.
 *
 * The item pane is a narrow column beside the library. A screening column's
 * distribution is the single most useful fact about a table; six of them
 * stacked is a wall. Both caps are deliberately small — the table itself is one
 * click away and shows all of it.
 */
const MAX_DISTRIBUTIONS = 2;
const MAX_DISTRIBUTION_ENTRIES = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

/** A snake_case column id as a label: `screening_decision` → `Screening decision`. */
export function humanizeColumnId(id: string): string {
    const words = id.replace(/[_-]+/g, ' ').trim();
    if (!words) return id;
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Milliseconds for a timestamp in either form this section meets: the log's ISO
 * strings and Zotero's SQL UTC (`2026-08-30 12:00:00`, no zone marker, always
 * UTC). Null for anything unparseable, which callers treat as "unknown" rather
 * than as a date at either extreme.
 */
export function parseTableTimestamp(
    value: string | null | undefined
): number | null {
    if (typeof value !== 'string' || !value) return null;
    const sql = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value);
    const parsed = Date.parse(sql ? `${sql[1]}T${sql[2]}Z` : value);
    return Number.isNaN(parsed) ? null : parsed;
}

/** Whether a value from a sidecar is a summary this module can count. */
function isUsableSummary(summary: unknown): summary is TableSummary {
    const candidate = summary as TableSummary | null;
    return (
        !!candidate &&
        typeof candidate === 'object' &&
        typeof candidate.rows === 'number' &&
        typeof candidate.columns === 'number'
    );
}

/**
 * The tip entry of a version log, or null when the log is empty or its newest
 * entry carries no usable summary.
 *
 * A hand-edited or partially written `history.json` is the case this defends
 * against: an entry without counts must send the caller to the spec rather than
 * render a table of zeroes.
 */
export function tipVersionEntry(
    history: TableVersionEntry[]
): TableVersionEntry | null {
    for (let index = history.length - 1; index >= 0; index--) {
        const entry = history[index];
        if (entry && isUsableSummary(entry.summary)) return entry;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

/**
 * The select/boolean distributions worth showing, most useful first.
 *
 * Role-bearing columns come first because a `screening_decision` breakdown is
 * the reason anyone looks; the rest keep declaration order. System columns are
 * skipped — a producer-owned enrichment column's value counts are bookkeeping,
 * not a finding. So is an entirely empty distribution, which would only say
 * that nothing has been filled in yet, which the coverage line already says.
 */
function buildDistributions(
    summary: TableSummary,
    headers: Record<string, string> | undefined
): TableSectionDistribution[] {
    const candidates: TableSectionDistribution[] = [];
    for (const [columnId, detail] of Object.entries(
        summary.columns_detail ?? {}
    )) {
        if (!detail || detail.system || !detail.distribution) continue;
        const all = Object.entries(detail.distribution)
            .filter(([, count]) => typeof count === 'number' && count > 0)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        if (all.length === 0) continue;
        candidates.push({
            columnId,
            label: headers?.[columnId] || humanizeColumnId(columnId),
            ...(detail.role ? { role: detail.role } : {}),
            entries: all
                .slice(0, MAX_DISTRIBUTION_ENTRIES)
                .map(([label, count]) => ({ label, count })),
            truncated: Math.max(0, all.length - MAX_DISTRIBUTION_ENTRIES),
        });
    }
    const ranked = [
        ...candidates.filter((entry) => entry.role),
        ...candidates.filter((entry) => !entry.role),
    ];
    return ranked.slice(0, MAX_DISTRIBUTIONS);
}

// ---------------------------------------------------------------------------
// The fields
// ---------------------------------------------------------------------------

/** The section's fields for a table whose spec could not be read at all. */
function emptyFields(annotations: number): TableSectionFields {
    return {
        source: null,
        rows: 0,
        columns: 0,
        cells: 0,
        filled: 0,
        unsure: 0,
        unsourced: 0,
        stale: 0,
        version: null,
        oldestVersion: null,
        historyTruncated: false,
        lastWriteAt: null,
        annotations,
        annotationsBeforeLastWrite: 0,
        annotationWarning: false,
        distributions: [],
        dimensionsLine: '',
        coverageLine: '',
        flagsLine: '',
        versionLine: '',
        headerSummary: '',
        warning: null,
        conflict: null,
        conflictLine: null,
    };
}

/**
 * Turns a summary and a version log into everything the section shows.
 *
 * Total: every absent input has a rendering. No summary yields a section with
 * no counts rather than no section, because "this is a Beaver table whose spec
 * we could not read" is still worth saying next to the item.
 */
export function buildTableSectionFields(
    input: TableSectionInput
): TableSectionFields {
    const annotationDates = input.annotationDates ?? [];
    const history = Array.isArray(input.history) ? input.history : [];
    const conflict = input.conflict ?? null;

    const oldestVersion = history.length ? history[0].version : null;
    const loggedTip = history.length ? history[history.length - 1].version : null;
    const version = input.version ?? loggedTip;
    const lastWriteAt = history.length ? (history[history.length - 1].at ?? null) : null;

    // Retention drops the oldest entries silently, so a user about to revert
    // needs to be told how far back the log still reaches. Only a log that
    // starts above v1 has lost anything.
    const historyTruncated = typeof oldestVersion === 'number' && oldestVersion > 1;

    // A snapshot annotation anchors by character offset into the rendered
    // document, and every write re-renders the whole document. An annotation
    // placed before the most recent write may therefore no longer sit on the
    // text it marked. An annotation with an unreadable date is left out rather
    // than assumed at risk — a warning that cannot be substantiated is noise.
    const writtenAtMs = parseTableTimestamp(lastWriteAt);
    let annotationsBeforeLastWrite = 0;
    if (writtenAtMs !== null) {
        for (const date of annotationDates) {
            const placedAtMs = parseTableTimestamp(date);
            if (placedAtMs !== null && placedAtMs < writtenAtMs) {
                annotationsBeforeLastWrite += 1;
            }
        }
    }

    const summary = isUsableSummary(input.summary) ? input.summary : null;
    if (!summary) {
        const fields = emptyFields(annotationDates.length);
        fields.version = version;
        fields.oldestVersion = oldestVersion;
        fields.historyTruncated = historyTruncated;
        fields.lastWriteAt = lastWriteAt;
        fields.versionLine = versionLineFor(version, oldestVersion, historyTruncated);
        fields.headerSummary = version === null ? '' : `v${version}`;
        fields.conflict = conflict;
        fields.conflictLine = conflict ? conflictLineFor(conflict) : null;
        return fields;
    }

    const rows = Math.max(0, summary.rows);
    const columns = Math.max(0, summary.columns);
    const cells = rows * columns;

    let filled = 0;
    let unsure = 0;
    let unsourced = 0;
    let stale = 0;
    for (const detail of Object.values(summary.columns_detail ?? {})) {
        if (!detail) continue;
        filled += detail.filled ?? 0;
        unsure += detail.unsure ?? 0;
        unsourced += detail.unsourced ?? 0;
        stale += detail.stale ?? 0;
    }

    const flags: string[] = [];
    if (unsure) flags.push(`${unsure} unsure`);
    if (unsourced) flags.push(`${unsourced} unsourced`);
    if (stale) flags.push(`${stale} stale`);

    const annotationWarning = annotationsBeforeLastWrite > 0;

    return {
        source: input.source,
        rows,
        columns,
        cells,
        filled,
        unsure,
        unsourced,
        stale,
        version,
        oldestVersion,
        historyTruncated,
        lastWriteAt,
        annotations: annotationDates.length,
        annotationsBeforeLastWrite,
        annotationWarning,
        distributions: buildDistributions(summary, input.headers),
        dimensionsLine: dimensionsLineFor(rows, columns),
        coverageLine: cells === 0 ? '' : `${filled} of ${plural(cells, 'cell', 'cells')} filled`,
        flagsLine: flags.join(' · '),
        versionLine: versionLineFor(version, oldestVersion, historyTruncated),
        headerSummary: headerSummaryFor(rows, version),
        warning: annotationWarning
            ? warningFor(annotationsBeforeLastWrite, version)
            : null,
        conflict,
        conflictLine: conflict ? conflictLineFor(conflict) : null,
    };
}

function dimensionsLineFor(rows: number, columns: number): string {
    if (rows === 0 && columns === 0) return 'Empty table';
    if (rows === 0) return `No rows yet · ${plural(columns, 'column', 'columns')}`;
    if (columns === 0) return plural(rows, 'row', 'rows');
    return `${plural(rows, 'row', 'rows')} × ${plural(columns, 'column', 'columns')}`;
}

function versionLineFor(
    version: number | null,
    oldestVersion: number | null,
    truncated: boolean
): string {
    if (version === null) return '';
    if (truncated && oldestVersion !== null) {
        return `Version ${version} · history goes back to v${oldestVersion}`;
    }
    return `Version ${version}`;
}

function headerSummaryFor(rows: number, version: number | null): string {
    const parts = [plural(rows, 'row', 'rows')];
    if (version !== null) parts.push(`v${version}`);
    return parts.join(' · ');
}

/**
 * The annotation caveat. Deliberately says "may have moved": the offsets shift
 * only where the edit landed before the annotation, and nothing here knows
 * where that was.
 */
/**
 * What the section says about a table another device's copy replaced.
 *
 * Both versions are named, because "your work was replaced" is useless without
 * saying by what and from where. The middle clause is the one that matters:
 * Zotero resolved a file conflict by keeping one whole copy, so nothing was
 * combined and Beaver did not write over anything — and a user who reads this
 * as "Beaver has already done something" would take the wrong next step. A
 * version whose spec was not retained says so plainly rather than offering an
 * action that cannot work.
 */
function conflictLineFor(conflict: TableSectionConflict): string {
    const showing =
        conflict.reason === 'diverged'
            ? `Showing a different version ${conflict.documentVersion} from another device`
            : `Showing version ${conflict.documentVersion} from another device`;
    const wrote = `this device last wrote version ${conflict.shadowVersion}`;
    const tail = conflict.restorable
        ? `your version ${conflict.shadowVersion} is kept here and can be restored as a new version.`
        : `but Beaver no longer keeps a copy of your version ${conflict.shadowVersion}.`;
    return `${showing}; ${wrote}. Nothing was merged and nothing was overwritten — ${tail}`;
}

function warningFor(count: number, version: number | null): string {
    const subject =
        count === 1
            ? '1 annotation was made'
            : `${count} annotations were made`;
    const since = version === null ? 'the table was last changed' : `version ${version}`;
    return `${subject} before ${since}. Re-rendering a table can move a highlight away from the text it marked.`;
}
