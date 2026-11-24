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
 * afterwards. Writes go through `/beaver/test/excluded-libraries`, which sets an
 * in-memory override that profile reads keep until teardown drops it — nothing
 * is persisted to the backend, so a run that dies before teardown is undone by
 * restarting Zotero. The override must outlast profile reads: clearing the set
 * lets background lanes send the excluded library to the backend, which answers
 * `library_excluded` and makes the instance reload the saved profile.
 */

import {
    getExcludedLibraries,
    resetExcludedLibraries,
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

/**
 * End the run's override, so the instance goes back to the saved set. Done even
 * when `clearExclusions()` changed nothing: a suite may have left an override.
 */
export async function restoreExclusions(): Promise<void> {
    if (!(await isZoteroAvailable())) return;
    try {
        const reset = await resetExcludedLibraries();
        if (!reset?.ok) throw new Error(reset?.error ?? 'unknown error');
    } catch (error) {
        // Without a confirmed reset the run's override may still be in place,
        // and it outlasts profile reads.
        console.warn(
            `\n[live-teardown] Could not reset the excluded-libraries override: ${error}.\n`
            + `            The run's set may still be active. Retry with POST `
            + `/beaver/test/excluded-libraries {"action":"reset"}, or restart Zotero.\n`,
        );
    }
}

/** Human-readable summary of a captured set, for the one-time run notice. */
export function describeExclusions(snapshot: NonNullable<ExclusionSnapshot>): string {
    return snapshot
        .map((entry) => (entry.type === 'group' ? `group:${entry.group_id}` : 'user'))
        .join(', ');
}
