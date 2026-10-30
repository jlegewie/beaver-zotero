/**
 * The table card's local state: one draft per card, edited step by step and
 * sent back as one `table_card_response`.
 *
 * Pure functions over a plain object, so the card's rules (steps, counts, the
 * row-cap warning, what Create sends) are testable without React. The draft
 * never holds rows: the backend resolves the returned entries again.
 */

import type {
    TableCardChoice,
    TableCardColumn,
    TableCardColumnType,
    TableCardCost,
    TableCardDestination,
    TableCardLibraryScope,
    TableCardOption,
    TableCardResolved,
    TableCardSource,
    WSTableCardEstimateRequest,
    WSTableCardEstimateResult,
    WSTableCardRequest,
    WSTableCardResponse,
    WSTableCreateCardRequest,
    WSTableFillCardRequest,
} from '../protocol/tableCardProtocol';
import {
    codePointLength,
    MAX_MODEL_COLUMNS,
    MAX_SELECT_DEFINITION_CHARS,
    MAX_SELECT_DEFINITIONS_CHARS,
    normalizeSelectLabel,
} from '../layouts/table';

export type TableCardStep = 'sources' | 'screening' | 'columns';

export interface DraftSource {
    /** Local, stable for the card's life. */
    key: string;
    type: 'items' | 'library';
    /** `items`: the ids still in the source, in order. */
    ids?: string[];
    /** `items`: ids removed on the card, kept so the removal can be undone. */
    removed?: string[];
    /** `items`: every id the source has held, in order, so undo restores a position. */
    order?: string[];
    /**
     * The item ids the source yields, once known (live resolution, or its item
     * list); they let the card count a paper in two sources once.
     */
    itemIds?: string[] | null;
    /** `library`: the collection, tag or saved search. */
    scope?: TableCardLibraryScope;
    /** The last known resolution; null until the first count lands. */
    resolved: TableCardResolved | null;
    /** A live count is in flight. */
    counting: boolean;
    /** Added on the card rather than proposed by the model. */
    fromCard: boolean;
}

/** A select option as edited on the card. */
export interface DraftOption {
    /** Local, unique within its column and stable for the card's life. */
    key: string;
    label: string;
    /** What counts as the category; empty means it has no definition. */
    description: string;
}

export interface DraftColumn {
    key: string;
    header: string;
    type: TableCardColumnType;
    description: string;
    options: DraftOption[];
}

export interface TableCardDraft {
    title: string;
    description: string;
    sources: DraftSource[];
    /** Null while the card has no Screening step. */
    criteria: string[] | null;
    columns: DraftColumn[];
    step: TableCardStep;
    /** The user changed the sources, so the backend's merge line no longer applies. */
    sourcesEdited: boolean;
    /** The cancel view is open: the card asks what Beaver should do instead. */
    cancelling: boolean;
    /** Sent only with a decline. */
    instructions: string;
    /** Counter for local keys. */
    nextKey: number;
    /** The cost the card shows, and the draft it was estimated for. */
    estimate: DraftEstimate;
}

/**
 * The card's cost. The backend owns the estimate: the request's cost holds
 * for the proposal as sent, and after the sources or the column set change
 * the card asks its waiting tool call for a new one (`table_card_estimate`).
 */
export interface DraftEstimate {
    /** The newest cost the backend answered; the request's until then. */
    cost: TableCardCost | null;
    /** The draft `cost` was estimated for ({@link estimateBasis}). */
    basis: string;
    /** The request id of the estimate in flight, if any. */
    pending: string | null;
    /** The draft the estimate in flight was asked for. */
    pendingBasis: string | null;
    /**
     * The draft the last estimate failed for. While the draft is unchanged the
     * card offers a retry; an edit asks again.
     */
    failedBasis: string | null;
}

const ITEMS_KEY = 'items';

function format(count: number): string {
    return count.toLocaleString('en-US');
}

function plural(count: number, noun: string, many = `${noun}s`): string {
    return `${format(count)} ${count === 1 ? noun : many}`;
}

export function initialTableCardDraft(request: WSTableCardRequest): TableCardDraft {
    let nextKey = 0;
    // A table has one Selected items source; item entries are folded into it.
    const itemIds = [...new Set(request.sources.flatMap((source) => (source.type === 'items' ? source.ids ?? [] : [])))];
    const itemEntries = request.sources.filter((source) => source.type === 'items');
    const proposal = request.sources.filter(
        (source, index) =>
            source.type === 'library' ||
            (source.type === 'items' && index === request.sources.indexOf(itemEntries[0])),
    );
    const sources: DraftSource[] = proposal
        .map((source) => ({
            key: source.type === 'items' ? ITEMS_KEY : `s${nextKey++}`,
            type: source.type as 'items' | 'library',
            ...(source.type === 'items'
                ? { ids: itemIds, removed: [], order: itemIds }
                : { scope: source.scope ?? undefined }),
            // Several item entries have no single resolution: count them again.
            resolved: source.type === 'items' && itemEntries.length > 1 ? null : source.resolved ?? null,
            counting: source.type === 'items' && itemEntries.length > 1,
            fromCard: false,
        }));
    const columns: DraftColumn[] = request.columns.map((column) => ({
        key: `c${nextKey++}`,
        header: column.header,
        type: column.type,
        description: column.description ?? '',
        options: draftOptions(column.options),
    }));
    const draft: TableCardDraft = {
        title: request.title,
        description: request.description,
        sources,
        criteria: request.criteria.length ? [...request.criteria] : null,
        columns,
        step: 'sources',
        sourcesEdited: false,
        cancelling: false,
        instructions: request.user_instructions_prefill ?? '',
        nextKey,
        estimate: { cost: request.cost, basis: '', pending: null, pendingBasis: null, failedBasis: null },
    };
    // The proposal as sent is what the request's cost was estimated for.
    return { ...draft, estimate: { ...draft.estimate, basis: estimateBasis(draft) } };
}

// Steps ------------------------------------------------------------------------

/** Sources, then Screening when the card has it, then Columns, always last. */
export function tableCardSteps(draft: TableCardDraft): TableCardStep[] {
    return draft.criteria === null ? ['sources', 'columns'] : ['sources', 'screening', 'columns'];
}

export function goToStep(draft: TableCardDraft, step: TableCardStep): TableCardDraft {
    return tableCardSteps(draft).includes(step) ? { ...draft, step } : draft;
}

export function nextStep(draft: TableCardDraft): TableCardDraft {
    const steps = tableCardSteps(draft);
    const index = steps.indexOf(draft.step);
    return index < steps.length - 1 ? { ...draft, step: steps[index + 1] } : draft;
}

export function previousStep(draft: TableCardDraft): TableCardDraft {
    const steps = tableCardSteps(draft);
    const index = steps.indexOf(draft.step);
    return index > 0 ? { ...draft, step: steps[index - 1] } : draft;
}

/** Insert an empty Screening step and go to it. */
export function addScreening(draft: TableCardDraft): TableCardDraft {
    if (draft.criteria !== null) return goToStep(draft, 'screening');
    return { ...draft, criteria: [], step: 'screening' };
}

export function removeScreening(draft: TableCardDraft): TableCardDraft {
    return { ...draft, criteria: null, step: draft.step === 'screening' ? 'sources' : draft.step };
}

// Header -------------------------------------------------------------------------

export function setTitle(draft: TableCardDraft, title: string): TableCardDraft {
    return { ...draft, title };
}

export function setDescription(draft: TableCardDraft, description: string): TableCardDraft {
    return { ...draft, description };
}

export function setInstructions(draft: TableCardDraft, instructions: string): TableCardDraft {
    return { ...draft, instructions };
}

/** Open or close the cancel view; the typed text and the edits are kept. */
export function setCancelling(draft: TableCardDraft, cancelling: boolean): TableCardDraft {
    return { ...draft, cancelling };
}

// Sources ----------------------------------------------------------------------

function updateSource(
    draft: TableCardDraft,
    key: string,
    update: (source: DraftSource) => DraftSource,
    edited = true,
): TableCardDraft {
    return {
        ...draft,
        sources: draft.sources.map((source) => (source.key === key ? update(source) : source)),
        sourcesEdited: draft.sourcesEdited || edited,
    };
}

export function removeSource(draft: TableCardDraft, key: string): TableCardDraft {
    return {
        ...draft,
        sources: draft.sources.filter((source) => source.key !== key),
        sourcesEdited: true,
    };
}

/** The single Selected items source, if the card has one. */
export function itemsSource(draft: TableCardDraft): DraftSource | undefined {
    return draft.sources.find((source) => source.type === 'items');
}

/**
 * Add picked items to the one Selected items source, creating it when the
 * card has none. An item removed on the card and picked again comes back.
 */
export function addItems(draft: TableCardDraft, ids: string[]): TableCardDraft {
    const existing = itemsSource(draft);
    if (!existing) {
        const fresh = [...new Set(ids)];
        if (!fresh.length) return draft;
        return {
            ...draft,
            sources: [
                ...draft.sources,
                {
                    key: ITEMS_KEY,
                    type: 'items',
                    ids: fresh,
                    removed: [],
                    order: fresh,
                    resolved: null,
                    counting: true,
                    fromCard: true,
                },
            ],
            sourcesEdited: true,
        };
    }
    const current = existing.ids ?? [];
    const added = ids.filter((id) => !current.includes(id));
    if (!added.length) return draft;
    return updateSource(draft, existing.key, (source) => {
        const order = source.order ?? current;
        return {
            ...source,
            ids: [...current, ...added],
            removed: (source.removed ?? []).filter((id) => !added.includes(id)),
            order: [...order, ...added.filter((id) => !order.includes(id))],
            counting: true,
        };
    });
}

/** Remove one item from the Selected items source; undo puts it back. */
export function removeItem(draft: TableCardDraft, id: string): TableCardDraft {
    const source = itemsSource(draft);
    if (!source || !source.ids?.includes(id)) return draft;
    return updateSource(draft, source.key, (s) => ({
        ...s,
        ids: s.ids!.filter((other) => other !== id),
        removed: [...(s.removed ?? []), id],
        counting: true,
    }));
}

export function undoRemoveItem(draft: TableCardDraft, id: string): TableCardDraft {
    const source = itemsSource(draft);
    if (!source || !source.removed?.includes(id)) return draft;
    return updateSource(draft, source.key, (s) => {
        const active = new Set([...(s.ids ?? []), id]);
        const order = s.order ?? [...(s.ids ?? []), id];
        return {
            ...s,
            ids: order.filter((other) => active.has(other)),
            removed: s.removed!.filter((other) => other !== id),
            counting: true,
        };
    });
}

function sameScope(a: TableCardLibraryScope, b: TableCardLibraryScope): boolean {
    return (
        a.kind === b.kind &&
        a.library_ref === b.library_ref &&
        (a.key ?? null) === (b.key ?? null) &&
        (a.tag ?? null) === (b.tag ?? null)
    );
}

/** Add a collection, tag or saved search as a source; a scope already on the card is not added twice. */
export function addLibrarySource(
    draft: TableCardDraft,
    scope: TableCardLibraryScope,
): { draft: TableCardDraft; key: string | null } {
    if (draft.sources.some((source) => source.scope && sameScope(source.scope, scope)))
        return { draft, key: null };
    const key = `s${draft.nextKey}`;
    return {
        key,
        draft: {
            ...draft,
            nextKey: draft.nextKey + 1,
            sources: [
                ...draft.sources,
                { key, type: 'library', scope, resolved: null, counting: true, fromCard: true },
            ],
            sourcesEdited: true,
        },
    };
}

/** The key of the library source for a scope, if the card has it. */
export function librarySourceKey(draft: TableCardDraft, scope: TableCardLibraryScope): string | null {
    return draft.sources.find((source) => source.scope && sameScope(source.scope, scope))?.key ?? null;
}

/**
 * Record a live count, and the item ids the source yields when they are
 * known. Not an edit: the merge line only changes with the sources.
 */
export function setSourceResolved(
    draft: TableCardDraft,
    key: string,
    resolved: TableCardResolved,
    itemIds?: string[],
): TableCardDraft {
    return updateSource(
        draft,
        key,
        (source) => ({ ...source, resolved, counting: false, ...(itemIds ? { itemIds } : {}) }),
        false,
    );
}

/** Record the item ids a source yields, looked up after its count. */
export function setSourceItemIds(draft: TableCardDraft, key: string, itemIds: string[]): TableCardDraft {
    return updateSource(draft, key, (source) => ({ ...source, itemIds }), false);
}

/** Give a library source its display name once known. */
export function setSourceName(draft: TableCardDraft, key: string, name: string): TableCardDraft {
    return updateSource(
        draft,
        key,
        (source) => (source.scope ? { ...source, scope: { ...source.scope, name } } : source),
        false,
    );
}

export function sourceCount(source: DraftSource): number {
    if (source.resolved) return source.resolved.count;
    return source.type === 'items' ? (source.ids ?? []).length : 0;
}

/** Matches before the cap; above the row cap the card warns. */
export function sourceTotal(source: DraftSource): number {
    return Math.max(source.resolved?.total ?? 0, sourceCount(source));
}

export function cardTotals(draft: TableCardDraft): { count: number; total: number } {
    return draft.sources.reduce(
        (sum, source) => ({
            count: sum.count + sourceCount(source),
            total: sum.total + sourceTotal(source),
        }),
        { count: 0, total: 0 },
    );
}

/**
 * The rows the table would have, as far as the card can tell: the backend's
 * merged count for the proposal as sent; after an edit, the distinct items
 * the sources yield, which counts a paper in two sources once. Until every
 * source's items are known it is the sum of their counts, an upper bound.
 * The backend's merge can still fold two different items that share a DOI.
 */
export function cardRowCount(draft: TableCardDraft, request: WSTableCreateCardRequest): number {
    if (!draft.sourcesEdited) return request.merge.rows;
    const distinct = distinctItemCount(draft);
    return distinct ?? cardTotals(draft).count;
}

/**
 * The papers the card reports: the table's rows, or, when the cap cut a source
 * short, at least that source's full size — the rows alone would understate
 * what the user asked for.
 */
export function cardPaperCount(draft: TableCardDraft, request: WSTableCreateCardRequest): number {
    const rows = cardRowCount(draft, request);
    const cut = draft.sources.filter((source) => sourceTotal(source) > request.row_cap || source.resolved?.truncated);
    return Math.max(rows, ...cut.map(sourceTotal));
}

/** Distinct items across the sources, or null while one source's items are unknown. */
export function distinctItemCount(draft: TableCardDraft): number | null {
    if (draft.sources.some((source) => !source.itemIds)) return null;
    return new Set(draft.sources.flatMap((source) => source.itemIds!)).size;
}

/**
 * The sources that carry the row-cap warning: each source the cap cut short,
 * otherwise, when the table's rows exceed the cap, the largest source.
 */
export function overCapSources(draft: TableCardDraft, request: WSTableCreateCardRequest): string[] {
    const rowCap = request.row_cap;
    const cut = draft.sources.filter((source) => sourceTotal(source) > rowCap || source.resolved?.truncated);
    if (cut.length) return cut.map((source) => source.key);
    if (cardRowCount(draft, request) <= rowCap) return [];
    const largest = [...draft.sources].sort((a, b) => sourceTotal(b) - sourceTotal(a))[0];
    return largest ? [largest.key] : [];
}

/**
 * The row-cap warning, the same whatever made the table too big: how many
 * items it would have, the maximum, and that removing sources fixes it.
 * Sources are taken as they are, so the card offers no other remedy.
 */
export function overCapMessage(draft: TableCardDraft, request: WSTableCreateCardRequest): string {
    return `This table would have ${plural(cardPaperCount(draft, request), 'item')}; the maximum is ${format(request.row_cap)}. Remove sources to continue.`;
}

/**
 * The line under the source list: the backend's merge for the proposal as
 * sent, or after an edit the sum with a note that duplicates merge on create.
 */
export function mergeLine(draft: TableCardDraft, request: WSTableCreateCardRequest): string | null {
    const several = draft.sources.length > 1;
    if (!draft.sourcesEdited) {
        const { rows, duplicates } = request.merge;
        if (!several && !duplicates) return null;
        const head = `${plural(rows, 'item')}${several ? ' across sources' : ''}`;
        return duplicates ? `${head}; found in more than one source, merged −${format(duplicates)}` : head;
    }
    if (!several) return null;
    return `${plural(cardRowCount(draft, request), 'item')} across sources; duplicates are merged on create`;
}

// Columns ----------------------------------------------------------------------

export function addColumn(draft: TableCardDraft): { draft: TableCardDraft; key: string } {
    const key = `c${draft.nextKey}`;
    return {
        key,
        draft: {
            ...draft,
            nextKey: draft.nextKey + 1,
            columns: [
                ...draft.columns,
                { key, header: '', type: 'text', description: '', options: [] },
            ],
        },
    };
}

export function updateColumn(
    draft: TableCardDraft,
    key: string,
    patch: Partial<Omit<DraftColumn, 'key'>>,
): TableCardDraft {
    return {
        ...draft,
        columns: draft.columns.map((column) => (column.key === key ? { ...column, ...patch } : column)),
    };
}

export function removeColumn(draft: TableCardDraft, key: string): TableCardDraft {
    return { ...draft, columns: draft.columns.filter((column) => column.key !== key) };
}

/**
 * Draft rows for a column's options. A bare label is read as an option
 * without a definition.
 */
export function draftOptions(options: readonly (TableCardOption | string)[] | null | undefined): DraftOption[] {
    return (options ?? []).map((option, index) =>
        typeof option === 'string'
            ? { key: `o${index}`, label: option, description: '' }
            : { key: `o${index}`, label: option.label ?? '', description: option.description ?? '' },
    );
}

let optionKeys = 0;

/**
 * A key for a row added on the card. Never reused, so state a view keeps per
 * row cannot carry over to a later one; the `n` prefix keeps it apart from the
 * `o<index>` keys of {@link draftOptions}.
 */
export function newOptionKey(): string {
    optionKeys += 1;
    return `n${optionKeys}`;
}

/** `options` with new rows for `labels` inserted at `index`, and the new rows' keys. */
export function insertOptions(
    options: readonly DraftOption[],
    index: number,
    labels: readonly string[],
): { options: DraftOption[]; keys: string[] } {
    const added = labels.map((label): DraftOption => ({ key: newOptionKey(), label, description: '' }));
    const next = [...options];
    next.splice(Math.max(0, Math.min(index, next.length)), 0, ...added);
    return { options: next, keys: added.map((option) => option.key) };
}

/**
 * A paste of several lines into an option's label: the first line replaces the
 * selection in that label, each further line becomes an option below it, and
 * blank lines are dropped. Null for a single line, which pastes as usual.
 */
export function pasteIntoOption(
    options: readonly DraftOption[],
    key: string,
    text: string,
    selectionStart: number,
    selectionEnd: number,
): { options: DraftOption[]; focusKey: string } | null {
    const lines = text.split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean);
    const index = options.findIndex((option) => option.key === key);
    if (lines.length < 2 || index < 0) return null;
    const current = options[index];
    const label = `${current.label.slice(0, selectionStart)}${lines[0]}${current.label.slice(selectionEnd)}`;
    const replaced = options.map((option) => (option.key === key ? { ...option, label } : option));
    const inserted = insertOptions(replaced, index + 1, lines.slice(1));
    return { options: inserted.options, focusKey: inserted.keys[inserted.keys.length - 1] };
}

/** The backend's limits on a select column's options. */
export const MAX_CARD_SELECT_OPTIONS = 50;
export const MAX_CARD_SELECT_LABEL_CHARS = 60;

/**
 * What keeps a column from being sent, or null. Select options are checked
 * the way the backend checks the reply: at most 50, each 1–60 characters
 * (code points, as Python counts them), and no two the same option under
 * {@link normalizeSelectLabel} — so `Yes` and `Yes.` are one option. A
 * definition needs its label and stays within 300 characters, and one column's
 * definitions within 3,000 together.
 */
export function columnProblem(column: DraftColumn): string | null {
    if (!column.header.trim()) return 'Add a name.';
    if (!column.description.trim()) return 'Add the question this column asks.';
    if (column.type === 'select') {
        const labels = column.options.map((option) => option.label.trim()).filter(Boolean);
        if (!labels.length) return 'Add at least one option.';
        if (labels.length > MAX_CARD_SELECT_OPTIONS)
            return `Use at most ${MAX_CARD_SELECT_OPTIONS} options, or a text column.`;
        if (labels.some((label) => codePointLength(label) > MAX_CARD_SELECT_LABEL_CHARS))
            return `Keep each option to ${MAX_CARD_SELECT_LABEL_CHARS} characters.`;
        const folded = labels.map(normalizeSelectLabel);
        if (new Set(folded).size !== folded.length) return 'Options must differ.';
        const defined = column.options.filter((option) => option.description.trim());
        if (defined.some((option) => !option.label.trim())) return 'Add a label to each defined option.';
        const lengths = defined.map((option) => codePointLength(option.description.trim()));
        if (lengths.some((length) => length > MAX_SELECT_DEFINITION_CHARS))
            return `Keep each definition to ${MAX_SELECT_DEFINITION_CHARS} characters.`;
        if (lengths.reduce((sum, length) => sum + length, 0) > MAX_SELECT_DEFINITIONS_CHARS)
            return `Keep the definitions to ${MAX_SELECT_DEFINITIONS_CHARS.toLocaleString('en-US')} characters together.`;
    }
    return null;
}

// Summaries and the footer ---------------------------------------------------------

/** One line for a completed step, so the card shows one part at a time. */
export function stepSummary(draft: TableCardDraft, step: TableCardStep, request: WSTableCreateCardRequest): string {
    if (step === 'sources') {
        const count = cardPaperCount(draft, request);
        return `${plural(count, 'item')} from ${plural(draft.sources.length, 'source')}`;
    }
    if (step === 'screening') {
        const criteria = draft.criteria ?? [];
        return criteria.length ? plural(criteria.length, 'criterion', 'criteria') : 'No criteria';
    }
    return draft.columns.length ? plural(draft.columns.length, 'question') : 'No questions';
}

/** The number a step's heading shows: items, criteria, or questions. */
export function stepCount(draft: TableCardDraft, step: TableCardStep, request: WSTableCreateCardRequest): number {
    if (step === 'sources') return cardPaperCount(draft, request);
    if (step === 'screening') return (draft.criteria ?? []).length;
    return draft.columns.length;
}

/**
 * Why Create is disabled: the message, the part of the card that needs the
 * fix (so the card can lead there), and whether it only needs to wait (a
 * count in flight) rather than a change.
 */
export interface CreateBlocker {
    message: string;
    part: 'title' | 'sources' | 'columns';
    pending?: boolean;
}

/**
 * Why Create is disabled, or null when it can be pressed. With `libraryOf`,
 * an edited card whose derived destination has nowhere to go is blocked too.
 */
export function createBlockerReason(
    draft: TableCardDraft,
    request: WSTableCreateCardRequest,
    libraryOf?: (ref: string) => DestinationLibrary | null,
): CreateBlocker | null {
    const sources = (message: string): CreateBlocker => ({ message, part: 'sources' });
    if (!draft.title.trim()) return { message: 'Add a title.', part: 'title' };
    if (!draft.sources.length) return sources('Add a source.');
    if (libraryOf && !cardDestination(draft, request, libraryOf)) return sources(NO_DESTINATION);
    if (draft.sources.some((source) => source.counting))
        return { message: 'Counting items…', part: 'sources', pending: true };
    const failed = draft.sources.find((source) => source.resolved?.error);
    if (failed) return sources('Remove the source that cannot be used.');
    if (cardTotals(draft).count === 0) return sources('The sources contain no items.');
    if (overCapSources(draft, request).length) return sources(overCapMessage(draft, request));
    if (!draft.columns.length) return { message: 'Add a question column.', part: 'columns' };
    if (draft.columns.length > MAX_MODEL_COLUMNS)
        return { message: `A table holds at most ${MAX_MODEL_COLUMNS} question columns.`, part: 'columns' };
    const incomplete = draft.columns.filter((column) => columnProblem(column));
    if (incomplete.length === 1) {
        const [column] = incomplete;
        const name = column.header.trim();
        // A column with no name can only be pointed at by what it lacks.
        const message = name ? `${name}: ${columnProblem(column)}` : 'A column needs a name.';
        return { message, part: 'columns' };
    }
    if (incomplete.length) return { message: `${incomplete.length} columns are incomplete.`, part: 'columns' };
    return null;
}

/** {@link createBlockerReason}'s message alone. */
export function createBlocker(
    draft: TableCardDraft,
    request: WSTableCreateCardRequest,
    libraryOf?: (ref: string) => DestinationLibrary | null,
): string | null {
    return createBlockerReason(draft, request, libraryOf)?.message ?? null;
}

/**
 * The buttons on the last step. With no cost there is one, "Create"; once a
 * run can be approved the primary is named for what runs and "Create only"
 * creates without running.
 */
export function createActions(
    draft: TableCardDraft,
    request: WSTableCreateCardRequest,
): { primary: { label: string; choice: TableCardChoice }; secondary?: { label: string; choice: TableCardChoice } } {
    if (!draft.estimate.cost) return { primary: { label: 'Create', choice: 'create' } };
    const screens = (draft.criteria ?? []).length > 0;
    const fills = draft.columns.length > 0;
    const label = screens && fills ? 'Create and run' : screens ? 'Create and screen' : 'Create and fill';
    return {
        primary: { label, choice: 'create_and_run' },
        secondary: { label: 'Create only', choice: 'create' },
    };
}

/**
 * A library as the destination rule needs it. `libraryOf` returns null for a
 * library Beaver cannot use (missing, or excluded), as the backend sees it.
 */
export interface DestinationLibrary {
    name: string;
    writable: boolean;
}

/** The blocker when a derived destination has nowhere to go. */
export const NO_DESTINATION =
    'My Library cannot hold the table (excluded or read-only). Keep the sources in one library Beaver can write to.';

/**
 * Where the table is filed for the card's current sources. An explicit
 * destination is kept. A derived one follows the backend's rule: one library
 * across the sources gives that library, and sources that are exactly one
 * collection give that collection too; otherwise, or when that library cannot
 * be written, the user library — or null when the user library cannot be
 * used either, which the backend refuses. The backend derives it again on
 * approval.
 */
export function cardDestination(
    draft: TableCardDraft,
    request: WSTableCreateCardRequest,
    libraryOf: (ref: string) => DestinationLibrary | null,
): TableCardDestination | null {
    if (request.destination.explicit || !draft.sourcesEdited) return request.destination;
    const refs = new Set<string>();
    for (const source of draft.sources) {
        if (source.scope) refs.add(source.scope.library_ref);
        for (const id of source.ids ?? []) refs.add(id.slice(0, id.indexOf('-')));
    }
    const fallback = (): TableCardDestination | null => {
        const user = libraryOf('u');
        if (!user?.writable) return null;
        return { library_ref: 'u', library_name: user.name, explicit: false };
    };
    if (refs.size !== 1) return fallback();
    const ref = [...refs][0];
    const library = libraryOf(ref);
    if (!library?.writable) return fallback();
    const only = draft.sources.length === 1 ? draft.sources[0] : null;
    if (only?.scope?.kind === 'collection' && only.scope.key) {
        return {
            library_ref: ref,
            library_name: library.name,
            collection_key: only.scope.key,
            collection_name: only.scope.name ?? only.scope.key,
            explicit: false,
        };
    }
    return { library_ref: ref, library_name: library.name, explicit: false };
}

/** The destination line under the title. */
export function destinationLine(destination: TableCardDestination): string {
    const { library_name, collection_name, collection_key } = destination;
    const collection = collection_name || collection_key;
    return `${library_name}${collection ? ` › ${collection}` : ''}`;
}

// Replies ------------------------------------------------------------------------

export function wireColumn(column: DraftColumn): TableCardColumn {
    const wire: TableCardColumn = {
        header: column.header.trim(),
        type: column.type,
        description: column.description.trim(),
    };
    if (column.type === 'select')
        wire.options = column.options.flatMap((option): TableCardOption[] => {
            const label = option.label.trim();
            const description = option.description.trim();
            if (!label) return [];
            return [description ? { label, description } : { label }];
        });
    return wire;
}

/** The approval: every part as edited, and the choice. */
export function tableCardResponse(
    draft: TableCardDraft,
    request: WSTableCreateCardRequest,
    choice: TableCardChoice,
): WSTableCardResponse {
    // Instructions travel only with a decline: an approval is the table as shown.
    return {
        type: 'table_card_response',
        card_id: request.card_id,
        approved: true,
        choice,
        // The estimate the card showed: approving grants its credits.
        estimate_id: draft.estimate.cost?.estimate_id ?? null,
        title: draft.title.trim(),
        description: draft.description.trim(),
        sources: draft.sources.flatMap((source): TableCardSource[] => {
            if (source.type === 'library') return [{ type: 'library', scope: { ...source.scope! } }];
            return (source.ids ?? []).length ? [{ type: 'items', ids: [...source.ids!] }] : [];
        }),
        criteria: draft.criteria ?? [],
        columns: draft.columns.map(wireColumn),
    };
}

/**
 * The approval of a fill card: nothing on it is editable, so it names the run
 * and the estimate it showed.
 */
export function tableFillCardResponse(request: WSTableFillCardRequest): WSTableCardResponse {
    return {
        type: 'table_card_response',
        card_id: request.card_id,
        approved: true,
        choice: 'fill',
        estimate_id: request.cost.estimate_id,
    };
}

/** "Fill 180": the fill card's run button, named for what runs. */
export function fillActionLabel(request: WSTableFillCardRequest): string {
    const rows = request.cost.extraction?.rows ?? 0;
    return `Fill ${format(rows)}`;
}

/** The decline; instructions make it a request for something else. */
export function tableCardDecline(draft: TableCardDraft, request: WSTableCardRequest): WSTableCardResponse {
    const instructions = draft.instructions.trim();
    return {
        type: 'table_card_response',
        card_id: request.card_id,
        approved: false,
        user_instructions: instructions || null,
    };
}

// Cost and the live estimate ------------------------------------------------------

/**
 * What a cost depends on in the draft: the sources (their content and their
 * resolved counts) and the set of columns. A header or question edit does not
 * change it; adding or removing a column does.
 */
export function estimateBasis(draft: TableCardDraft): string {
    return JSON.stringify({
        sources: draft.sources.map((source) => [
            source.type,
            source.ids ?? null,
            source.scope ? [source.scope.kind, source.scope.library_ref, source.scope.key ?? null, source.scope.tag ?? null] : null,
            source.resolved ? [source.resolved.count, source.resolved.total, source.resolved.without_pdf] : null,
        ]),
        columns: draft.columns.map((column) => column.key),
    });
}

/**
 * Whether the card asks for estimates at all: when the request quoted a cost,
 * or proposed no columns (nothing to run yet). A run that cannot pay for a
 * fill is sent `cost: null` with its columns, and stays at "Create".
 */
export function canEstimate(request: WSTableCreateCardRequest): boolean {
    return request.cost !== null || request.columns.length === 0;
}

/**
 * Where the card's cost stands: `current` for the draft as it is, `pending`
 * while an estimate is in flight, `failed` after one failed, `stale` when the
 * draft changed since and no estimate was asked for yet.
 */
export function estimateStatus(
    draft: TableCardDraft,
    request: WSTableCreateCardRequest,
): 'current' | 'pending' | 'failed' | 'stale' {
    if (!canEstimate(request)) return 'current';
    if (draft.estimate.pending) return 'pending';
    const basis = estimateBasis(draft);
    if (draft.estimate.basis === basis) return 'current';
    return draft.estimate.failedBasis === basis ? 'failed' : 'stale';
}

/**
 * Whether the card should ask for an estimate now: the draft differs from
 * what the shown cost was estimated for, nothing is in flight, and every
 * source has its count. Only on the last step, where the run choice is.
 */
export function needsEstimate(draft: TableCardDraft, request: WSTableCreateCardRequest): boolean {
    if (!canEstimate(request) || draft.estimate.pending || draft.step !== 'columns') return false;
    if (draft.sources.some((source) => source.counting || !source.resolved)) return false;
    const basis = estimateBasis(draft);
    return draft.estimate.basis !== basis && draft.estimate.failedBasis !== basis;
}

/** The estimate request for the draft as it is, and the draft marked pending. */
export function startEstimate(
    draft: TableCardDraft,
    request: WSTableCreateCardRequest,
    requestId: string,
): { draft: TableCardDraft; message: WSTableCardEstimateRequest } {
    const message: WSTableCardEstimateRequest = {
        type: 'table_card_estimate',
        card_id: request.card_id,
        request_id: requestId,
        sources: draft.sources.flatMap((source): TableCardSource[] => {
            const resolved = source.resolved ?? undefined;
            if (source.type === 'library') return [{ type: 'library', scope: { ...source.scope! }, resolved }];
            return (source.ids ?? []).length ? [{ type: 'items', ids: [...source.ids!], resolved }] : [];
        }),
        columns: draft.columns.map(wireColumn),
    };
    return {
        message,
        draft: {
            ...draft,
            estimate: { ...draft.estimate, pending: requestId, pendingBasis: estimateBasis(draft), failedBasis: null },
        },
    };
}

/**
 * Apply the backend's answer. A result for an estimate the card no longer
 * waits on is dropped. The new cost holds for the draft the request was
 * built from; if the draft has moved on since, the card asks again.
 */
export function applyEstimateResult(draft: TableCardDraft, result: WSTableCardEstimateResult): TableCardDraft {
    const { estimate } = draft;
    if (estimate.pending !== result.request_id) return draft;
    if (result.error)
        return { ...draft, estimate: { ...estimate, pending: null, pendingBasis: null, failedBasis: estimate.pendingBasis } };
    return {
        ...draft,
        estimate: { cost: result.cost ?? null, basis: estimate.pendingBasis ?? '', pending: null, pendingBasis: null, failedBasis: null },
    };
}

/** The estimate in flight did not come back: the card shows it failed and offers a retry. */
export function failEstimate(draft: TableCardDraft, requestId: string): TableCardDraft {
    const { estimate } = draft;
    if (estimate.pending !== requestId) return draft;
    return { ...draft, estimate: { ...estimate, pending: null, pendingBasis: null, failedBasis: estimate.pendingBasis } };
}

/** Ask again after a failure. */
export function retryEstimate(draft: TableCardDraft): TableCardDraft {
    return draft.estimate.failedBasis !== null ? { ...draft, estimate: { ...draft.estimate, failedBasis: null } } : draft;
}

/**
 * The row line: "Fills 180 rows: 150 from the attachment, 18 from title and
 * abstract, 12 without either", with "up to" while the count is not exact.
 * The attachment is whichever document the row reads: PDF, EPUB or snapshot.
 */
export function costLine(cost: TableCardCost | null): string | null {
    const extraction = cost?.extraction;
    if (!extraction) return null;
    const { rows, documents, no_input } = extraction;
    const metadata = Math.max(0, rows - documents - no_input);
    const head = `Fills ${extraction.upper_bound ? 'up to ' : ''}${plural(rows, 'row')}`;
    const parts = [
        documents > 0 ? `${format(documents)} from the attachment` : null,
        metadata > 0 ? `${format(metadata)} from title and abstract` : null,
        no_input > 0 ? `${format(no_input)} without either` : null,
    ].filter(Boolean);
    return parts.length ? `${head}: ${parts.join(', ')}` : head;
}

/** A credit figure without trailing-zero noise, as the batch card writes it. */
function formatCredits(credits: number): string {
    const rounded = Math.round(credits * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : String(Number(rounded.toPrecision(6)));
}

/** The credit chip, only when approving raises what the run authorizes. */
export function creditChip(cost: TableCardCost | null): string | null {
    return typeof cost?.credits === 'number' ? `Up to ${formatCredits(cost.credits)} this run` : null;
}

/** The sentence the chip abbreviates: what approving authorizes, not what it costs. */
export function creditTooltip(cost: TableCardCost | null): string | null {
    if (typeof cost?.credits !== 'number') return null;
    const amount = formatCredits(cost.credits);
    const word = Math.round(cost.credits * 100) / 100 === 1 ? 'credit' : 'credits';
    return (
        `Approving authorizes up to ${amount} ${word} for this run. ` +
        "You are charged for what the run actually uses, which is usually less. " +
        "You'll be asked again if the run uses more."
    );
}
