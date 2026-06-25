import { logger } from '../utils/logger';

export const RELEASE_DEBOUNCE_MS = 1000;
export const SAFETY_IDLE_MS = 600_000;

/**
 * Seconds Zotero waits after an edit before auto-syncing (mirrors Zotero's
 * AutoSyncListener edit timeout). Used to schedule a single post-run sync so the
 * run's edits are pushed promptly once suppression is lifted.
 */
const AUTO_SYNC_EDIT_TIMEOUT_SECONDS = 3;

type ResumeSync = () => void;
export type SyncPauseOwner = string;

export const LOCAL_MUTATING_RUN_SYNC_PAUSE_OWNER = 'local-mutating-run';
export const PROVIDER_MUTATING_RUN_SYNC_PAUSE_OWNER = 'provider-mutating-run';

interface SyncRunner {
    delayIndefinite?: () => ResumeSync;
    delaySync?: (ms: number) => void;
    clearSyncTimeout?: () => void;
    setSyncTimeout?: (timeout: number, recurring: boolean, options?: object) => void;
}

let resumeSync: ResumeSync | null = null;
let safetyTimer: ReturnType<typeof setTimeout> | null = null;
const releaseDebounceTimers = new Map<SyncPauseOwner, ReturnType<typeof setTimeout>>();
const activeOwners = new Set<SyncPauseOwner>();

// eslint-disable-next-line no-restricted-globals -- intentionally this script's window, not getMainWindow()
const currentWindow: Window | undefined = typeof window !== 'undefined' ? window : undefined;

/** The live Zotero sync runner, or null when Zotero is unavailable. */
function getRunner(): SyncRunner | null {
    return typeof Zotero !== 'undefined' ? ((Zotero as any).Sync?.Runner ?? null) : null;
}

/**
 * Keep Zotero's auto-sync from animating the sync indicator mid-run.
 *
 * `delayIndefinite()` alone is not enough: Zotero's auto-sync timer fires a few
 * seconds after an edit and calls `sync()`, which animates the sync icon BEFORE
 * it consults the indefinite-delay set. So the spinner shows even though no data
 * is actually pushed. Cancelling the pending auto-sync timer and pushing the
 * auto-sync "do not start" window (`delaySync`) forward instead makes the timer
 * callback wait BEFORE it animates the icon, so edits made during the run never
 * spin the indicator. Re-applied on every mutating action so long runs and
 * freshly-armed timers stay covered.
 */
function suppressAutoSync(runner: SyncRunner): void {
    if (typeof runner.clearSyncTimeout === 'function') {
        runner.clearSyncTimeout();
    }
    if (typeof runner.delaySync === 'function') {
        runner.delaySync(SAFETY_IDLE_MS);
    }
}

/**
 * Restore normal auto-sync after a run. Always drops the suppression window so
 * future syncs are not held off; when `reschedule` is set (a real run finished),
 * also arms a single auto-sync so the run's edits are pushed promptly.
 */
function restoreAutoSync(runner: SyncRunner, reschedule: boolean): void {
    if (typeof runner.delaySync === 'function') {
        // A past instant clears the window without leaving it null (matches how
        // Zotero itself only ever sets this to concrete dates).
        runner.delaySync(0);
    }
    if (reschedule && typeof runner.setSyncTimeout === 'function') {
        runner.setSyncTimeout(AUTO_SYNC_EDIT_TIMEOUT_SECONDS, false);
    }
}

/** Clear the pending debounced release, if one is armed. */
function clearReleaseDebounce(owner: SyncPauseOwner): void {
    const timer = releaseDebounceTimers.get(owner);
    if (timer) {
        clearTimeout(timer);
        releaseDebounceTimers.delete(owner);
    }
}

/** Clear all pending debounced releases. */
function clearAllReleaseDebounces(): void {
    for (const timer of releaseDebounceTimers.values()) {
        clearTimeout(timer);
    }
    releaseDebounceTimers.clear();
}

/** Clear the idle safety timer, if one is armed. */
function clearSafetyTimer(): void {
    if (safetyTimer !== null) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
    }
}

/** Re-arm the idle backstop that releases sync suppression after a dead run. */
function armSafetyTimer(): void {
    clearSafetyTimer();
    safetyTimer = setTimeout(() => {
        logger(`syncPause: idle safety timer fired after ${SAFETY_IDLE_MS}ms, releasing`, 2);
        // Backstop for a leaked pause: restore normal auto-sync without forcing a
        // sync (a dead run is abnormal; let the next edit/idle trigger it).
        resumeSyncNow(false);
    }, SAFETY_IDLE_MS);
}

/** Pause Zotero sync before a mutating agent action can schedule auto-sync. */
export function pauseSyncForMutatingRun(owner: SyncPauseOwner = LOCAL_MUTATING_RUN_SYNC_PAUSE_OWNER): void {
    try {
        const runner = getRunner();
        if (typeof runner?.delayIndefinite !== 'function') {
            return;
        }

        clearReleaseDebounce(owner);
        activeOwners.add(owner);
        armSafetyTimer();

        // Suppress the visible auto-sync spinner for edits made during the run.
        suppressAutoSync(runner);

        if (resumeSync !== null) {
            return;
        }

        // Hard guarantee that even a manual/in-flight sync can't push data
        // mid-run; released once the run settles.
        resumeSync = runner.delayIndefinite();
        logger('syncPause: paused Zotero sync for mutating run', 3);
    } catch (err) {
        logger('Zotero sync pause failed', { error: String(err) }, 1);
    }
}

/** Schedule sync to resume after the run has stayed inactive past the debounce. */
export function scheduleResumeAfterRun(owner: SyncPauseOwner = LOCAL_MUTATING_RUN_SYNC_PAUSE_OWNER): void {
    clearReleaseDebounce(owner);
    releaseDebounceTimers.set(owner, setTimeout(() => {
        // Normal completion: push the run's edits with one batched auto-sync.
        releaseOwner(owner, true);
    }, RELEASE_DEBOUNCE_MS));
    logger(`syncPause: scheduled resume in ${RELEASE_DEBOUNCE_MS}ms`, 3);
}

/** Cancel a pending debounced resume when a run becomes active again. */
export function cancelScheduledResume(owner: SyncPauseOwner = LOCAL_MUTATING_RUN_SYNC_PAUSE_OWNER): void {
    if (releaseDebounceTimers.has(owner)) {
        logger('syncPause: cancelled scheduled resume (run active again)', 3);
    }
    clearReleaseDebounce(owner);
}

/** Release one owner and resume Zotero sync only when no other owner remains. */
function releaseOwner(owner: SyncPauseOwner, reschedule: boolean): void {
    clearReleaseDebounce(owner);
    activeOwners.delete(owner);
    if (activeOwners.size > 0) {
        return;
    }
    resumeSyncNow(reschedule);
}

/**
 * Resume Zotero sync immediately. Safe to call repeatedly.
 *
 * @param reschedule When true, schedule a single auto-sync so the run's edits
 *   are pushed promptly. Left false for the test/unload paths, which only need
 *   to restore normal auto-sync behavior.
 */
export function resumeSyncNow(reschedule = false): void {
    clearAllReleaseDebounces();
    clearSafetyTimer();
    activeOwners.clear();

    const resume = resumeSync;
    resumeSync = null;
    if (!resume) {
        return;
    }

    try {
        resume();
        logger('syncPause: resumed Zotero sync', 3);
    } catch (err) {
        logger('Zotero sync resume failed', { error: String(err) }, 1);
    }

    try {
        const runner = getRunner();
        if (runner) {
            restoreAutoSync(runner, reschedule);
        }
    } catch (err) {
        logger('Zotero sync restore failed', { error: String(err) }, 1);
    }
}

/** Whether a Zotero sync pause is currently held by this module. */
export function isSyncPaused(): boolean {
    return resumeSync !== null;
}

try {
    const previousResume = currentWindow?.__beaverResumeSyncAfterRun;
    if (previousResume && previousResume !== resumeSyncNow) {
        previousResume();
    }
} catch (err) {
    logger('Previous Zotero sync resume hook failed', { error: String(err) }, 1);
}

if (currentWindow) {
    currentWindow.__beaverResumeSyncAfterRun = resumeSyncNow;
}
