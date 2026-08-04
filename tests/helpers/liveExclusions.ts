/**
 * Library-exclusion normalization for live/integration runs.
 *
 * Beaver's excluded-libraries set is a user preference stored on the account
 * profile, so it is inherited by every Zotero instance that logs in — including
 * a freshly cloned worktree profile. The live fixtures assume every local
 * library is readable, so an exclusion the developer set in Beaver Preferences
 * (or a leak from an interrupted earlier run) turns into a spray of failures
 * that read like product bugs: `library_excluded` errors from group-library
 * tests, or note tests failing because the user library is excluded.
 *
 * These helpers clear the set for the duration of a run and put it back
 * afterwards. Writes go through `/beaver/test/excluded-libraries`, which mutates
 * the in-memory profile only — nothing is persisted to the backend, so a run
 * that dies before teardown is undone by restarting Zotero.
 */

import {
    getExcludedLibraries,
    restoreExcludedLibraries,
    setExcludedLibraries,
    type ExcludedLibraryEntry,
} from './cacheInspector';
import { isZoteroAvailable } from './zoteroAvailability';

/** What was excluded before we cleared it, or null when nothing was changed. */
export type ExclusionSnapshot = ExcludedLibraryEntry[] | null;

/**
 * Make every local library searchable, returning what to pass to
 * `restoreExclusions()`. No-op (returns null) when Zotero is unavailable, no
 * profile is loaded, or nothing was excluded to begin with.
 */
export async function clearExclusions(): Promise<ExclusionSnapshot> {
    if (!(await isZoteroAvailable())) return null;

    let state;
    try {
        state = await getExcludedLibraries();
    } catch {
        return null;
    }
    if (!state?.has_profile) return null;

    const original = state.excluded_libraries ?? [];
    if (original.length === 0) return null;

    const cleared = await setExcludedLibraries([]);
    if (!cleared?.ok) {
        throw new Error(
            'Could not clear the excluded-libraries set for this run: '
            + (cleared?.error ?? 'unknown error'),
        );
    }
    return original;
}

/** Put back a set captured by `clearExclusions()`. Safe to call with null. */
export async function restoreExclusions(snapshot: ExclusionSnapshot): Promise<void> {
    if (!snapshot) return;
    try {
        await restoreExcludedLibraries(snapshot);
    } catch {
        // Best effort: the set is in-memory only, so a failure here is undone
        // by the next Zotero restart rather than corrupting anything.
    }
}

/** Human-readable summary of a captured set, for the one-time run notice. */
export function describeExclusions(snapshot: NonNullable<ExclusionSnapshot>): string {
    return snapshot
        .map((entry) => (entry.type === 'group' ? `group:${entry.group_id}` : 'user'))
        .join(', ');
}
