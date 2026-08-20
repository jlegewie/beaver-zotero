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
