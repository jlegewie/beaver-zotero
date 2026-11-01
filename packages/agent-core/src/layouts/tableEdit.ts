/**
 * Building and changing a table from the provider's `create` and
 * `apply_edit` and from the tab's structural edits: the pure half.
 *
 * Sources are resolved first, outside the table's lock, into
 * {@link ResolvedSource}s (rows with their metadata identifiers, built from
 * Zotero by the plugin's resolver). The functions here then merge those rows
 * into the table and turn one call into one list of engine mutations, applied
 * all at once against the table as it stands under the lock, and the change
 * list the call reports. No Zotero, no I/O.
 */

import {
    IDENTIFIER_COLUMN_ID,
    isFillableColumn,
    MAX_REASONING_BYTES,
    MAX_ROWS,
    REFERENCE_COLUMN_ID,
    SELECT_COLORS,
    YEAR_COLUMN_ID,
    TABLE_SPEC_VERSION,
    utf8Length,
    type Cell,
    type CellValue,
    type Column,
    type Row,
    type SelectColor,
    type SourceEntry,
    type TableSpec,
} from "./table";
import { mergeRows, type RawIdentifiers } from "./tableMerge";
import {
    applyMutations,
    paperKey,
    type MutationReport,
    type TableMutation,
    type UpdateColumnOption,
} from "./tableMutations";
import type {
    TableChange,
    TableColumnDraft,
    TableColumnUpdate,
    TableEditColumnType,
    TableEditOperations,
    TablePreview,
    TableRejectedItem,
} from "../protocol/tableEditProtocol";

/** How a fill would answer a row. */
export type ResolvedRowMode = "document" | "title_abstract" | "no_input";

/** One paper a source yields, as a row without its origin. */
export interface ResolvedPaper {
    row: Row;
    /** The item's full metadata identifiers, for the merge. */
    identifiers?: RawIdentifiers | null;
    mode: ResolvedRowMode;
}

/** One source entry as the resolver found it. */
export interface ResolvedSource {
    /**
     * The entry as it would be stored: an items entry lists only the papers
     * that yield a row; a library entry carries its scope's display name.
     */
    entry: SourceEntry;
    papers: ResolvedPaper[];
    /** Papers before the row cap. */
    total: number;
    truncated: boolean;
    rejected: TableRejectedItem[];
    /** The source cannot be used. */
    error?: string;
}

/**
 * A column update from the tab: the model's fields, plus what only the user
 * changes. A new `type` clears the column's answers (a select column then
 * needs its `options`); `existing_answers` overrides what a changed question
 * does to them: `keep` leaves them fresh, `refill` marks them out of date.
 */
export interface TableUserColumnUpdate extends TableColumnUpdate {
    type?: TableEditColumnType | null;
    existing_answers?: "keep" | "refill" | null;
}

/** One edit from the tab: the model's operations, with user column updates. */
export interface TableUserEdit extends Omit<TableEditOperations, "update_columns"> {
    update_columns?: TableUserColumnUpdate[] | null;
}

/** A refusal, with a message that names the parameter and its index. */
export interface EditFailure {
    ok: false;
    code: "unknown_column" | "unknown_row" | "unknown_source" | "invalid_edit" | "too_large" | "source_unavailable" | "no_rows";
    message: string;
}

export interface EditResult {
    ok: true;
    spec: TableSpec;
    changes: TableChange[];
}

const SAMPLE_SIZE = 5;

/** The system columns every table starts with. */
export function systemColumns(): Column[] {
    return [
        { id: REFERENCE_COLUMN_ID, header: "Reference", type: "reference", system: true },
        { id: YEAR_COLUMN_ID, header: "Year", type: "date", system: true, priority: "secondary" },
        { id: IDENTIFIER_COLUMN_ID, header: "Identifier", type: "link", system: true, priority: "secondary" },
    ];
}

/** A column id from a header: lowercase words joined by underscores, unique in `taken`. */
export function columnIdFor(base: string, taken: ReadonlySet<string>): string {
    let id = base.trim().startsWith("_") ? "" : base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!id) id = "column";
    let candidate = id;
    for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${id}_${suffix}`;
    return candidate;
}

function colorFor(index: number, taken: Set<SelectColor | undefined>): SelectColor {
    const rotation = SELECT_COLORS.filter((color) => color !== "gray");
    for (let step = 0; step < rotation.length; step += 1) {
        const color = rotation[(index + step) % rotation.length];
        if (!taken.has(color)) return color;
    }
    return rotation[index % rotation.length];
}

/** The stored column for a draft, with an id unique in `taken` and coloured options. */
export function columnFromDraft(draft: TableColumnDraft, taken: ReadonlySet<string>): Column {
    const column: Column = {
        id: columnIdFor(draft.id || draft.header, taken),
        header: draft.header,
        type: draft.type,
    };
    if (draft.description) column.description = draft.description;
    if (draft.options) {
        const colors = new Set<SelectColor | undefined>();
        column.options = draft.options.map((option, index) => {
            const color = colorFor(index, colors);
            colors.add(color);
            return option.description ? { label: option.label, color, description: option.description } : { label: option.label, color };
        });
    }
    return column;
}

function sourceName(entry: SourceEntry): { kind?: string; name?: string; library_ref?: string } {
    const scope = entry.scope;
    if (!scope) return {};
    const name = scope.kind === "tag" ? scope.tag : scope.name;
    return { kind: scope.kind, ...(name ? { name } : {}), library_ref: scope.library_ref };
}

/**
 * The `add_rows` that land a merge: the rows added, in full, and the stored
 * rows that gained an origin, by id and origin only, so their cells (and
 * their `stale` flags) are left as they are.
 */
function mergedRows(before: readonly Row[], merged: readonly Row[]): Row[] {
    const stored = new Map(before.map((row) => [row.id, row]));
    const out: Row[] = [];
    for (const row of merged) {
        const previous = stored.get(row.id);
        if (!previous) out.push(row);
        else if (JSON.stringify(previous.origin ?? []) !== JSON.stringify(row.origin ?? []))
            out.push({ id: row.id, origin: row.origin, cells: {} });
    }
    return out;
}

function withOrigin(paper: ResolvedPaper, source: string, date: string): { row: Row; identifiers?: RawIdentifiers | null } {
    return { row: { ...paper.row, origin: [{ source, date }] }, identifiers: paper.identifiers };
}

// --- preview -------------------------------------------------------------------

/** What a proposal's sources give: the facts the create card shows and prices. */
export function previewFacts(resolved: readonly ResolvedSource[], rowCap = MAX_ROWS): TablePreview {
    const modes = new Map<string, ResolvedRowMode>();
    const incoming: { row: Row; identifiers?: RawIdentifiers | null }[] = [];
    for (const source of resolved)
        for (const paper of source.papers) {
            incoming.push(withOrigin(paper, source.entry.id, "1970-01-01"));
            modes.set(paper.row.id, paper.mode);
        }
    const merged = mergeRows([], incoming);
    // A merged row is answered from a document when any of its papers has one.
    const rowModes = merged.rows.map((row) => modes.get(row.id) ?? (row.documents?.length ? "document" : "title_abstract"));
    return {
        sources: resolved.map((source) => ({
            entry: source.entry as TablePreview["sources"][number]["entry"],
            count: source.papers.length,
            total: Math.max(source.total, source.papers.length),
            truncated: source.truncated,
            without_document: source.papers.filter((paper) => paper.mode !== "document").length,
            sample: source.papers.slice(0, SAMPLE_SIZE).map((paper) => {
                const value = paper.row.cells[REFERENCE_COLUMN_ID]?.value;
                const ref = paper.row.ref;
                const id = ref && "zotero_key" in ref ? `${ref.library_ref}-${ref.zotero_key}` : paper.row.id;
                const title = value?.kind === "reference" ? value.title || value.display_name : id;
                return { id, title: title.slice(0, 300) };
            }),
            rejected: source.rejected,
            ...(source.error ? { error: source.error } : {}),
        })),
        rows: merged.rows.length,
        duplicates: merged.merged,
        total: resolved.reduce((sum, source) => sum + Math.max(source.total, source.papers.length), 0),
        documents: rowModes.filter((mode) => mode === "document").length,
        title_abstract: rowModes.filter((mode) => mode === "title_abstract").length,
        no_input: rowModes.filter((mode) => mode === "no_input").length,
        row_cap: rowCap,
    };
}

// --- create --------------------------------------------------------------------

/**
 * A new table from approved sources and columns: the system columns, the
 * question columns, the merged rows with their origins, and the sources as
 * resolved. Refuses a source cut short or rows over the cap (`too_large`), no
 * rows (`no_rows`) and a column the engine refuses (`invalid_edit`).
 */
export function buildTable(
    input: { id: string; title: string; description?: string | null; columns?: TableColumnDraft[] | null },
    resolved: readonly ResolvedSource[],
    today: string,
    rowCap = MAX_ROWS,
): EditResult | EditFailure {
    const unusable = resolved.findIndex((source) => source.error);
    if (unusable !== -1)
        return { ok: false, code: "source_unavailable", message: `sources[${unusable}]: ${resolved[unusable].error}` };
    const facts = previewFacts(resolved, rowCap);
    const cut = resolved.findIndex((source) => source.truncated);
    if (cut !== -1 || facts.rows > rowCap)
        return {
            ok: false,
            code: "too_large",
            message:
                cut !== -1
                    ? `sources[${cut}]: the source holds ${resolved[cut].total} papers and a table holds at most ${rowCap}. Narrow it or remove it.`
                    : `the sources hold ${facts.rows} papers and a table holds at most ${rowCap}. Narrow a source or remove one.`,
        };
    if (!facts.rows) return { ok: false, code: "no_rows", message: "The approved sources yield no papers." };
    const base: TableSpec = {
        id: input.id,
        spec_version: TABLE_SPEC_VERSION,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        anchor_column_id: REFERENCE_COLUMN_ID,
        columns: [],
        rows: [],
    };
    const taken = new Set(systemColumns().map((column) => column.id));
    const columns = (input.columns ?? []).map((draft) => {
        const column = columnFromDraft(draft, taken);
        taken.add(column.id);
        return column;
    });
    const mutations: TableMutation[] = [{ op: "add_columns", columns: [...systemColumns(), ...columns] }];
    const changes: TableChange[] = [];
    // One merge over every source's papers, as the preview merges them, so
    // each paper's full identifiers meet every other's and the table matches
    // the preview the card showed. A paper counts as added by the first
    // source that found it and as a duplicate in every later one.
    const incoming = resolved.flatMap((source) => source.papers.map((paper) => withOrigin(paper, source.entry.id, today)));
    const merged = mergeRows([], incoming);
    const seen = new Set<string>();
    let at = 0;
    for (const source of resolved) {
        mutations.push({ op: "add_sources", sources: [source.entry] });
        let added = 0;
        let duplicates = 0;
        for (let i = 0; i < source.papers.length; i++, at++) {
            const landed = merged.landed[at];
            if (seen.has(landed)) duplicates += 1;
            else {
                seen.add(landed);
                added += 1;
            }
        }
        changes.push({
            op: "add_source",
            source: source.entry.id,
            type: source.entry.type,
            ...sourceName(source.entry),
            rows_added: added,
            rows_restored: 0,
            duplicates,
            rejected: source.rejected,
        });
    }
    mutations.push({ op: "add_rows", rows: merged.rows });
    const applied = applyMutations(base, mutations);
    if (!applied.ok) return { ok: false, code: applied.error.code === "too_large" ? "too_large" : "invalid_edit", message: applied.error.message };
    for (const column of columns) changes.push({ op: "add_column", column: column.id, header: column.header });
    return { ok: true, spec: applied.spec, changes };
}

// --- edit ----------------------------------------------------------------------

/** What `apply_edit` resolved before taking the lock. */
export interface ResolvedEdit {
    /** `add_sources[i]`, in order. */
    added: ResolvedSource[];
    /** Each refreshed library entry, by source id. */
    refreshed: Map<string, ResolvedSource>;
}

/** The library entries `refresh_sources` names in `spec`. */
export function refreshTargets(spec: TableSpec, refresh: TableEditOperations["refresh_sources"]): SourceEntry[] {
    if (refresh == null) return [];
    const library = (spec.sources ?? []).filter((source) => source.type === "library");
    return refresh === true ? library : library.filter((source) => refresh.includes(source.id));
}

function nextSourceNumber(spec: TableSpec): number {
    let highest = 0;
    for (const source of spec.sources ?? []) {
        const match = /^s(\d+)$/.exec(source.id);
        if (match) highest = Math.max(highest, Number(match[1]));
    }
    return highest + 1;
}

function optionUpdates(update: TableColumnUpdate): UpdateColumnOption[] | undefined {
    if (update.options == null) return undefined;
    return update.options.map((option) => {
        const next: UpdateColumnOption = { label: option.label };
        if ("description" in option) next.description = option.description ?? null;
        if (option.previous_label != null) next.previous_label = option.previous_label;
        return next;
    });
}

type ColumnChangeField = Extract<TableChange, { op: "update_column" }>["fields"][number];

/**
 * What an update changed. Apart from a type change, whether the question changed is the engine's
 * answer, the one its staleness follows: renames and re-spellings are not a
 * new question, and removing an option counts only when it had a definition.
 */
function columnFields(before: Column, after: Column, report: MutationReport): ColumnChangeField[] {
    const fields: ColumnChangeField[] = [];
    // A new type replaces the question and the options with it: the change
    // names the type, and the header or question text if they moved too.
    if (before.type !== after.type) {
        fields.push("type");
        if (before.header !== after.header) fields.push("header");
        if ((before.description ?? "") !== (after.description ?? "")) fields.push("question");
        return fields;
    }
    if (before.header !== after.header) fields.push("header");
    if (report.question_changed) fields.push("question");
    const labels = (column: Column) => JSON.stringify((column.options ?? []).map((o) => o.label));
    if (labels(before) !== labels(after)) fields.push("options");
    return fields;
}

/**
 * One `edit_table` call against the table as it stands: all of it or none of
 * it. The order is fixed: title and description; removals (rows, columns,
 * sources); column updates; column additions; source additions; refresh. An
 * id the table does not have refuses the whole call (`unknown_*`), as does an
 * addition over the row cap (`too_large`).
 */
export function applyEdit(
    spec: TableSpec,
    operations: TableUserEdit,
    resolved: ResolvedEdit,
    now: string,
    rowCap = MAX_ROWS,
): EditResult | EditFailure {
    const today = now.slice(0, 10);
    const changes: TableChange[] = [];
    let current = spec;
    const step = (mutations: TableMutation[], where: string): EditFailure | MutationReport[] => {
        const applied = applyMutations(current, mutations);
        if (!applied.ok) {
            const code = applied.error.code;
            return {
                ok: false,
                code:
                    code === "unknown_column" || code === "unknown_row" || code === "unknown_source" || code === "too_large"
                        ? code
                        : "invalid_edit",
                message: `${where}: ${applied.error.message}`,
            };
        }
        current = applied.spec;
        return applied.reports;
    };
    const failed = (value: EditFailure | MutationReport[]): value is EditFailure => !Array.isArray(value);

    // Title and description.
    if (operations.title != null || operations.description != null) {
        const meta: TableMutation = { op: "set_meta" };
        if (operations.title != null) meta.title = operations.title;
        if (operations.description != null) meta.description = operations.description || null;
        const result = step([meta], "title");
        if (failed(result)) return result;
        if (operations.title != null) changes.push({ op: "title", title: operations.title });
        if (operations.description != null) changes.push({ op: "description" });
        if (operations.description === "") delete (current as { description?: string | null }).description;
    }

    // Removals: rows, then columns, then sources.
    if (operations.remove_rows?.length) {
        const known = new Set(current.rows.map((row) => row.id));
        const at = operations.remove_rows.findIndex((id) => !known.has(id));
        if (at !== -1)
            return { ok: false, code: "unknown_row", message: `remove_rows[${at}]: row ${operations.remove_rows[at]} does not exist. Read the table again.` };
        const result = step([{ op: "remove_rows", rows: [...new Set(operations.remove_rows)], removed_at: now }], "remove_rows");
        if (failed(result)) return result;
        changes.push({ op: "remove_rows", rows: result[0].rows_removed ?? 0 });
    }
    for (const [index, id] of (operations.remove_columns ?? []).entries()) {
        const column = current.columns.find((c) => c.id === id);
        if (!column || column.system)
            return { ok: false, code: "unknown_column", message: `remove_columns[${index}]: column ${id} does not exist. Read the table again.` };
        const result = step([{ op: "remove_columns", columns: [id] }], `remove_columns[${index}]`);
        if (failed(result)) return result;
        changes.push({ op: "remove_column", column: id, header: column.header, cleared: result[0].cleared ?? 0, user_cleared: result[0].user_cleared ?? 0 });
    }
    const nextSource = nextSourceNumber(spec);
    for (const [index, id] of (operations.remove_sources ?? []).entries()) {
        const entry = (current.sources ?? []).find((source) => source.id === id);
        if (!entry)
            return { ok: false, code: "unknown_source", message: `remove_sources[${index}]: source ${id} does not exist. Read the table again.` };
        const result = step([{ op: "remove_sources", sources: [id] }], `remove_sources[${index}]`);
        if (failed(result)) return result;
        changes.push({ op: "remove_source", source: id, type: entry.type, ...sourceName(entry), rows_removed: result[0].rows_removed ?? 0 });
    }

    // Column updates, then additions.
    for (const [index, update] of (operations.update_columns ?? []).entries()) {
        const before = current.columns.find((c) => c.id === update.id);
        if (!before || before.system)
            return { ok: false, code: "unknown_column", message: `update_columns[${index}]: column ${update.id} does not exist. Read the table again.` };
        const mutation: TableMutation = { op: "update_column", column: update.id };
        if (update.header != null) mutation.header = update.header;
        if (update.description != null) mutation.description = update.description;
        const options = optionUpdates(update);
        if (options) mutation.options = options;
        if (update.type != null && update.type !== before.type) mutation.type = update.type;
        if (update.existing_answers != null) mutation.existing_answers = update.existing_answers;
        const result = step([mutation], `update_columns[${index}]`);
        if (failed(result)) return result;
        const after = current.columns.find((c) => c.id === update.id)!;
        changes.push({
            op: "update_column",
            column: update.id,
            header: after.header,
            fields: columnFields(before, after, result[0]),
            stale: result[0].stale ?? 0,
            cleared: result[0].cleared ?? 0,
            user_cleared: result[0].user_cleared ?? 0,
            relabelled: result[0].relabelled ?? 0,
        });
    }
    for (const [index, draft] of (operations.add_columns ?? []).entries()) {
        if (draft.after != null && !current.columns.some((c) => c.id === draft.after))
            return { ok: false, code: "unknown_column", message: `add_columns[${index}]: column ${draft.after} does not exist. Read the table again.` };
        const column = columnFromDraft(draft, new Set(current.columns.map((c) => c.id)));
        const result = step([{ op: "add_columns", columns: [column], ...(draft.after ? { after: draft.after } : {}) }], `add_columns[${index}]`);
        if (failed(result)) return result;
        changes.push({ op: "add_column", column: column.id, header: column.header });
    }

    // Source additions, then refresh.
    let number = nextSource;
    const removedKeys = () => new Set((current.removed ?? []).map((paper) => paperKey(paper.ref)));
    // Every added source is checked first, then all their papers are merged
    // into the table in one pass, so each paper's full identifiers meet every
    // other new paper's (a DOI and PMID in one source join a PMID-only copy in
    // another). A paper counts as added by the first source that found it,
    // as a duplicate when it joins a stored row or an earlier source's paper.
    const additions: { entry: SourceEntry; source: ResolvedSource }[] = [];
    const scopes = new Set(
        (current.sources ?? []).flatMap((s) => (s.scope ? [`${s.scope.kind}\u0000${s.scope.library_ref}\u0000${s.scope.key ?? s.scope.tag}`] : [])),
    );
    let itemsId: string | undefined = (current.sources ?? []).find((s) => s.type === "items")?.id;
    for (const [index, draft] of (operations.add_sources ?? []).entries()) {
        const source = resolved.added[index];
        if (!source)
            return { ok: false, code: "invalid_edit", message: `add_sources[${index}]: the source was not resolved` };
        if (source.error)
            return { ok: false, code: "source_unavailable", message: `add_sources[${index}]: ${source.error}` };
        if (source.truncated)
            return {
                ok: false,
                code: "too_large",
                message: `add_sources[${index}]: the source holds ${source.total} papers and a table holds at most ${rowCap}. Narrow it.`,
            };
        let entry: SourceEntry;
        if (draft.type === "items") {
            itemsId ??= `s${number++}`;
            entry = { id: itemsId, type: "items", ids: source.entry.ids ?? [] };
        } else {
            const scope = source.entry.scope!;
            const key = `${scope.kind}\u0000${scope.library_ref}\u0000${scope.key ?? scope.tag}`;
            if (scopes.has(key))
                return { ok: false, code: "invalid_edit", message: `add_sources[${index}]: the table already has this ${scope.kind.replace("_", " ")}` };
            scopes.add(key);
            entry = { ...source.entry, id: `s${number++}` };
        }
        additions.push({ entry, source });
    }
    if (additions.length) {
        const removed = removedKeys();
        const stored = new Set(current.rows.map((row) => row.id));
        const merged = mergeRows(
            current.rows,
            additions.flatMap(({ entry, source }) => source.papers.map((paper) => withOrigin(paper, entry.id, today))),
        );
        const result = step(
            [
                { op: "add_sources", sources: additions.map(({ entry }) => entry) },
                // Stored rows gain the new origins; new rows are appended.
                { op: "add_rows", rows: mergedRows(current.rows, merged.rows) },
            ],
            "add_sources",
        );
        if (failed(result)) return result;
        const seen = new Set<string>();
        const newRows = new Map(merged.rows.filter((row) => !stored.has(row.id)).map((row) => [row.id, row]));
        let at = 0;
        for (const { entry, source } of additions) {
            let added = 0;
            let restored = 0;
            let duplicates = 0;
            for (let k = 0; k < source.papers.length; k++, at++) {
                const landed = merged.landed[at];
                if (stored.has(landed) || seen.has(landed)) {
                    duplicates += 1;
                    continue;
                }
                seen.add(landed);
                const ref = newRows.get(landed)?.ref;
                if (ref && removed.has(paperKey(ref))) restored += 1;
                else added += 1;
            }
            changes.push({
                op: "add_source",
                source: entry.id,
                type: entry.type,
                ...sourceName(entry),
                rows_added: added,
                rows_restored: restored,
                duplicates,
                rejected: source.rejected,
            });
        }
    }
    // The library entries to refresh are the table's as the call found them
    // (and still has): a source this call added was just resolved.
    const kept = new Set((current.sources ?? []).map((source) => source.id));
    const toRefresh = refreshTargets(spec, operations.refresh_sources ?? null).filter((entry) => kept.has(entry.id));
    if (operations.refresh_sources != null) {
        const targets = toRefresh;
        if (!targets.length)
            return { ok: false, code: "unknown_source", message: "refresh_sources: the table has no collection, tag or saved search to refresh. Read the table again." };
        if (Array.isArray(operations.refresh_sources)) {
            const known = new Set(targets.map((s) => s.id));
            const at = operations.refresh_sources.findIndex((id) => !known.has(id));
            if (at !== -1)
                return { ok: false, code: "unknown_source", message: `refresh_sources[${at}]: source ${operations.refresh_sources[at]} does not exist. Read the table again.` };
        }
    }
    // All refreshed sources are merged in one pass, like added ones, so a
    // paper's full identifiers meet every other new paper's.
    const refreshes: { entry: SourceEntry; source: ResolvedSource; fresh: ResolvedPaper[] }[] = [];
    for (const entry of toRefresh) {
        const source = resolved.refreshed.get(entry.id);
        const where = `refresh_sources (${entry.id})`;
        if (!source) return { ok: false, code: "invalid_edit", message: `${where}: the source was not resolved` };
        if (source.error) return { ok: false, code: "source_unavailable", message: `${where}: ${source.error}` };
        // A source cut short by the row cap is not its whole population:
        // refreshing from part of it would miss papers and misreport rows.
        if (source.truncated)
            return {
                ok: false,
                code: "too_large",
                message: `${where}: the source holds ${source.total} papers and a table holds at most ${rowCap}. Narrow it.`,
            };
        const removed = removedKeys();
        const fresh = source.papers.filter((paper) => !paper.row.ref || !removed.has(paperKey(paper.row.ref)));
        refreshes.push({ entry, source, fresh });
    }
    if (refreshes.length) {
        const before = current.rows;
        const stored = new Set(before.map((row) => row.id));
        const merged = mergeRows(
            before,
            refreshes.flatMap(({ entry, fresh }) => fresh.map((paper) => withOrigin(paper, entry.id, today))),
        );
        const result = step([{ op: "add_rows", rows: mergedRows(before, merged.rows) }], "refresh_sources");
        if (failed(result)) return result;
        const seen = new Set<string>();
        let at = 0;
        for (const { entry, source, fresh } of refreshes) {
            const yielded = new Set<string>();
            let added = 0;
            for (let k = 0; k < fresh.length; k++, at++) {
                const landed = merged.landed[at];
                yielded.add(landed);
                if (!stored.has(landed) && !seen.has(landed)) {
                    seen.add(landed);
                    added += 1;
                }
            }
            changes.push({
                op: "refresh_source",
                source: entry.id,
                ...sourceName(entry),
                rows_added: added,
                removed_skipped: source.papers.length - fresh.length,
                no_longer_found: before.filter(
                    (row) => row.origin?.some((origin) => origin.source === entry.id) && !yielded.has(row.id),
                ).length,
            });
        }
    }
    if (current.rows.length > rowCap && current.rows.length > spec.rows.length)
        return {
            ok: false,
            code: "too_large",
            message: `this change would give the table ${current.rows.length} rows; a table holds at most ${rowCap}. Narrow the source or start a second table.`,
        };
    return { ok: true, spec: current, changes };
}

// ---------------------------------------------------------------------------
// Cell edits from the tab
// ---------------------------------------------------------------------------

/**
 * One cell edit from the tab (section 5 of the table design). `answer`,
 * `not_reported` and `clear` write the user's cell, which no fill touches;
 * `restore` gives the cell back to Beaver (`restore_cell`); `document`
 * chooses the document a row is read from, which puts its answers out of
 * date. `expected` is the row's documents as the user saw them: a row that
 * names others by now is refused rather than switched under a concurrent
 * writer.
 */
export type TableCellEdit =
    | { op: "answer"; row: string; column: string; value: CellValue; note?: string | null }
    | { op: "not_reported"; row: string; column: string; note?: string | null }
    | { op: "clear"; row: string; column: string }
    | { op: "restore"; row: string; column: string }
    | { op: "document"; row: string; document: string; expected: string[] };

/** The engine mutations for a cell edit, checked against the table as it stands. */
export function cellEditMutations(
    spec: TableSpec,
    edit: TableCellEdit,
): { ok: true; mutations: TableMutation[] } | EditFailure {
    const row = spec.rows.find((candidate) => candidate.id === edit.row);
    if (!row) return { ok: false, code: "unknown_row", message: "This row is no longer in the table." };
    if (edit.op === "document") {
        if (typeof edit.document !== "string" || !edit.document)
            return { ok: false, code: "invalid_edit", message: "No document was chosen." };
        return {
            ok: true,
            mutations: [{ op: "update_row", row: row.id, documents: [edit.document], expected_documents: edit.expected }],
        };
    }
    const column = spec.columns.find((candidate) => candidate.id === edit.column);
    if (!column) return { ok: false, code: "unknown_column", message: "This column is no longer in the table." };
    if (!isFillableColumn(column))
        return { ok: false, code: "invalid_edit", message: `“${column.header}” is not a question column.` };
    if (edit.op === "restore") return { ok: true, mutations: [{ op: "restore_cell", row: row.id, column: column.id }] };
    const note = typeof (edit as { note?: unknown }).note === "string" ? (edit as { note: string }).note.trim() : "";
    let cell: Cell;
    if (edit.op === "clear") {
        cell = { outcome: "cleared", provenance: "user" };
    } else if (edit.op === "not_reported") {
        cell = { outcome: "not_reported", provenance: "user", ...(note ? { reasoning: note } : {}) };
    } else {
        const problem = userValueProblem(column, edit.value);
        if (problem) return { ok: false, code: "invalid_edit", message: problem };
        const value = edit.value.kind === "text" ? { kind: "text" as const, text: edit.value.text.trim() } : edit.value;
        cell = { outcome: "answered", provenance: "user", value, ...(note ? { reasoning: note } : {}) };
    }
    if (utf8Length(note) > MAX_REASONING_BYTES)
        return { ok: false, code: "invalid_edit", message: "The note is too long. Shorten it and save again." };
    return { ok: true, mutations: [{ op: "set_cells", cells: [{ row: row.id, column: column.id, cell }] }] };
}

/** Why a value cannot be the user's answer in this column, or null. */
function userValueProblem(column: Column, value: CellValue | undefined): string | null {
    if (!value || value.kind !== column.type) return `This answer does not fit the column “${column.header}”.`;
    switch (value.kind) {
        case "text":
            return value.text.trim() ? null : "Write an answer, or clear the cell.";
        case "date":
            return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(value.value) ? null : "Write the date as YYYY, YYYY-MM or YYYY-MM-DD.";
        case "boolean":
            return typeof value.value === "boolean" ? null : "Choose Yes or No.";
        case "select":
            return column.options?.some((option) => option.label === value.label)
                ? null
                : `“${value.label}” is not one of the column's options.`;
        default:
            return `This answer does not fit the column “${column.header}”.`;
    }
}
