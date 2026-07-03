import { getPref, setPref } from '../../src/utils/prefs';
import { logger } from '../../src/utils/logger';

export type FirstRunSelectionVariant = 'first_run' | 'where_to_start';

const VARIANTS: readonly FirstRunSelectionVariant[] = [
    'first_run',
    'where_to_start',
];

type AssignmentMap = Record<string, FirstRunSelectionVariant>;

function isVariant(value: unknown): value is FirstRunSelectionVariant {
    return VARIANTS.includes(value as FirstRunSelectionVariant);
}

function readAssignments(): AssignmentMap {
    const raw = getPref('firstRunAssignments');
    if (!raw) return {};

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }

        const assignments: AssignmentMap = {};
        for (const [userId, variant] of Object.entries(parsed)) {
            if (typeof userId === 'string' && isVariant(variant)) {
                assignments[userId] = variant;
            }
        }
        return assignments;
    } catch (e) {
        logger(`FirstRunSelection: failed to read assignments: ${e}`, 1);
        return {};
    }
}

function writeAssignments(assignments: AssignmentMap): void {
    try {
        setPref('firstRunAssignments', JSON.stringify(assignments));
    } catch (e) {
        logger(`FirstRunSelection: failed to persist assignment: ${e}`, 1);
    }
}

/**
 * Return the sticky first-run surface for a Beaver account, assigning it on
 * first use. The assignment is account-scoped within this Zotero profile so
 * reloads and window reopenings do not flip the user's onboarding surface.
 */
export function getFirstRunSelectionVariant(userId: string): FirstRunSelectionVariant {
    const assignments = readAssignments();
    const existing = assignments[userId];
    if (existing) return existing;

    const assigned: FirstRunSelectionVariant = Math.random() < 0.5
        ? 'first_run'
        : 'where_to_start';
    assignments[userId] = assigned;
    writeAssignments(assignments);
    logger(`FirstRunSelection: assigned ${assigned} to user ${userId}`);
    return assigned;
}
