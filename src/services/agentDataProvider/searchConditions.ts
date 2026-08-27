/**
 * Shared translation of wire search conditions into `Zotero.Search` conditions.
 *
 * Used by every handler that accepts the `zotero_search` condition grammar
 * (`handleZoteroSearchRequest`, `handleResolvePopulationRequest`). Keep it the
 * single implementation: a condition that one handler accepts and another
 * silently drops changes which items a batch operates on.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { ZoteroSearchCondition } from '@beaver/agent-core/protocol/agentProtocol';

/**
 * What this module needs of a search object.
 *
 * Declared structurally rather than as `Zotero.Search`: checking either search
 * type against that interface makes the compiler walk a type deep enough to
 * trip TS2589 ("excessively deep") at every call site.
 */
export interface SearchConditionTarget {
    addCondition(condition: string, operator: string, value: string, required?: boolean): number;
}

/**
 * Zotero conditions that restructure a search rather than narrow it.
 *
 * `Zotero.Search` accepts these happily, so `addCondition` would not reject one
 * and it would never become a warning — `joinMode any` alone turns an ANDed
 * filter set into an ORed one, which for a population about to be mutated means
 * every item the loosest filter touches. The handler owns them and sets them
 * itself, so a caller may not smuggle one in as a condition.
 *
 * The line is drawn at widening, not at unfamiliarity: a condition that
 * compiles to one more ANDed `itemID IN (…)` can only shrink the result and
 * belongs to the caller. `unfiled`, `retracted`, `publications`, `feed`,
 * `savedSearch` and the `quicksearch-*` family are all of that kind and are
 * deliberately absent.
 */
const CONTROL_CONDITION_FIELDS = new Set([
    // Join semantics and grouping.
    'joinMode', 'blockStart', 'blockEnd',
    // Which items are admitted alongside the ones that matched.
    'recursive', 'noChildren',
    'includeParentsAndChildren', 'includeParents', 'includeChildren',
    // The trash boundary.
    'deleted', 'includeDeleted',
]);

/**
 * Wire operator names that map onto a `Zotero.Search` operator. Unknown names
 * are passed through unchanged so `addCondition` can reject them (and the
 * rejection becomes a warning) rather than being silently rewritten.
 */
const OPERATOR_MAP: Record<string, string> = {
    'is': 'is',
    'isNot': 'isNot',
    'contains': 'contains',
    'doesNotContain': 'doesNotContain',
    'beginsWith': 'beginsWith',
    'isLessThan': 'isLessThan',
    'isGreaterThan': 'isGreaterThan',
    'isBefore': 'isBefore',
    'isAfter': 'isAfter',
    'isInTheLast': 'isInTheLast',
};

/** How many example item type names an unknown-`itemType` warning lists. */
const ITEM_TYPE_SAMPLE_SIZE = 12;

/**
 * A sample of the item type names Zotero accepts, for the unknown-`itemType`
 * warning.
 *
 * Read from Zotero rather than listed here so the sample can never disagree
 * with what a search actually accepts. Sorted by `itemTypeID` and truncated:
 * the lowest ids are Zotero's long-standing core types and types added to the
 * schema later get higher ids, so the sample stays short and stable as Zotero
 * gains types. The warning presents it as examples, not the full set.
 *
 * `getAll()` hands back Zotero's own live array, so copy before sorting.
 *
 * Throws when item type data is not loaded yet; callers must treat that as
 * "skip validation".
 */
function sampleItemTypeNames(): string[] {
    return Zotero.ItemTypes.getAll()
        .slice()
        .sort((a, b) => a.id - b.id)
        .slice(0, ITEM_TYPE_SAMPLE_SIZE)
        .map(type => type.name);
}

/**
 * Whether Zotero accepts `operator` for `condition`.
 *
 * Used to skip a value check when the operator is already wrong, so the caller
 * hears about one problem at a time. Answers true when Zotero cannot be asked,
 * which leaves `addCondition` to report whatever is actually wrong.
 */
function acceptsOperator(condition: string, operator: string): boolean {
    try {
        return Zotero.SearchConditions.hasOperator(condition, operator);
    } catch {
        return true;
    }
}

/**
 * Add one wire condition to `search`, handling the operator mapping and the
 * empty-value quirk.
 *
 * A condition Zotero rejects is dropped and recorded in `warnings` instead of
 * failing the whole request. Dropping a condition WIDENS the result set, so
 * callers must surface `warnings` to the backend unchanged.
 *
 * @param logLabel Handler name used as the log-line prefix.
 * @returns true when the condition was added, false when it was dropped.
 */
export function addSearchCondition(
    search: SearchConditionTarget,
    condition: ZoteroSearchCondition,
    warnings: string[],
    logLabel: string,
    libraryID?: number,
): boolean {
    const originalOperator = condition.operator;

    if (CONTROL_CONDITION_FIELDS.has(condition.field)) {
        logger(`${logLabel}: Refused control condition ${condition.field}`, 1);
        warnings.push(
            `Dropped condition field='${condition.field}': it controls how the search runs, `
                + 'not what it matches, and cannot be given as a condition.'
        );
        return false;
    }

    let operator = OPERATOR_MAP[originalOperator] || originalOperator;
    let value = condition.value ?? '';

    // Handle search for empty fields (Zotero quirk)
    // "field is empty" must be expressed as "field doesNotContain ''"
    if (operator === 'is' && (value === null || value === undefined || value === '')) {
        operator = 'doesNotContain';
        value = '';
    }

    // Zotero validates the condition name and the operator, but never the
    // value, so the two checks below do it. Both are skipped when the operator
    // is one Zotero refuses for this condition: `addCondition` reports that
    // below, and a value complaint would send the caller to fix the wrong half.
    const operatorAccepted = acceptsOperator(condition.field, operator);

    // An unknown item type compiles to a subquery that matches nothing, so the
    // search would return zero results with no indication why. Name the bad
    // value instead, and drop the condition like the rejection path below.
    if (condition.field === 'itemType' && value !== '' && operatorAccepted) {
        try {
            // getID returns false for a name no item type has.
            if (!Zotero.ItemTypes.getID(value)) {
                logger(`${logLabel}: Unknown item type '${value}'`, 1);
                warnings.push(
                    `Dropped condition field='itemType' value='${value}': no item type has that name. `
                        + `Item types include: ${sampleItemTypeNames().join(', ')}. `
                        + "Use list_items or get_metadata to see an item's own type."
                );
                return false;
            }
        } catch (err) {
            // Item type data is loaded lazily and is not ready yet. Let the
            // condition through unvalidated — a cold cache must never block a
            // search — and leave any mismatch to return no results.
            const msg = err instanceof Error ? err.message : String(err);
            logger(`${logLabel}: Skipped item type validation for '${value}': ${msg}`, 1);
        }
    }

    // A collection Zotero cannot resolve is NOT a condition that matches
    // nothing: it compiles to `itemID IN (0)`, and under `isNot` that negates
    // to every non-annotation item. So an unknown key silently turns a
    // narrowing condition into one that matches the whole library — and inside
    // a `joinMode any` group, one such disjunct makes the entire group match
    // everything. Refuse it here, where the key can still be named.
    if (condition.field === 'collection' && value !== '' && operatorAccepted && libraryID !== undefined) {
        try {
            // Zotero parses a legacy '<libraryID>_<key>' value server-side, so
            // only the key half identifies the collection.
            const key = /^\d+_/.test(value) ? value.slice(value.indexOf('_') + 1) : value;
            if (!Zotero.Collections.getByLibraryAndKey(libraryID, key)) {
                logger(`${logLabel}: Unknown collection key '${value}'`, 1);
                warnings.push(
                    `Dropped condition field='collection' value='${value}': this library has no `
                        + 'collection with that key. Use list_collections to get the key. Zotero '
                        + 'treats an unknown collection as one that matches nothing, which under '
                        + "'isNot' would select the whole library."
                );
                return false;
            }
        } catch (err) {
            // Collection data is loaded lazily. Let the condition through
            // unvalidated rather than block a search on a cold cache.
            const msg = err instanceof Error ? err.message : String(err);
            logger(`${logLabel}: Skipped collection validation for '${value}': ${msg}`, 1);
        }
    }

    try {
        search.addCondition(condition.field, operator, String(value));  // Value is always a string
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger(`${logLabel}: Invalid condition ${condition.field} ${originalOperator}: ${msg}`, 1);
        warnings.push(
            `Dropped condition field='${condition.field}' operator='${originalOperator}' value='${String(condition.value ?? '')}': ${msg}`
        );
        return false;
    }
}
