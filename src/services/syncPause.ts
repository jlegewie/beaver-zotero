import { logger } from '../utils/logger';

export const RELEASE_DEBOUNCE_MS = 1000;
export const SAFETY_IDLE_MS = 600_000;

type ResumeSync = () => void;

let resumeSync: ResumeSync | null = null;
let safetyTimer: ReturnType<typeof setTimeout> | null = null;
let releaseDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// eslint-disable-next-line no-restricted-globals -- intentionally this script's window, not getMainWindow()
const currentWindow: Window | undefined = typeof window !== 'undefined' ? window : undefined;

/** Clear the pending debounced release, if one is armed. */
function clearReleaseDebounce(): void {
    if (releaseDebounceTimer !== null) {
        clearTimeout(releaseDebounceTimer);
        releaseDebounceTimer = null;
    }
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
        resumeSyncNow();
    }, SAFETY_IDLE_MS);
}

/** Pause Zotero sync before a mutating agent action can schedule auto-sync. */
export function pauseSyncForMutatingRun(): void {
    try {
        const runner = typeof Zotero !== 'undefined' ? (Zotero as any).Sync?.Runner : null;
        if (typeof runner?.delayIndefinite !== 'function') {
            return;
        }

        clearReleaseDebounce();
        armSafetyTimer();

        if (resumeSync !== null) {
            return;
        }

        resumeSync = runner.delayIndefinite();
        logger('syncPause: paused Zotero sync for mutating run', 3);
    } catch (err) {
        logger('Zotero sync pause failed', { error: String(err) }, 1);
    }
}

/** Schedule sync to resume after the run has stayed inactive past the debounce. */
export function scheduleResumeAfterRun(): void {
    clearReleaseDebounce();
    releaseDebounceTimer = setTimeout(() => {
        resumeSyncNow();
    }, RELEASE_DEBOUNCE_MS);
    logger(`syncPause: scheduled resume in ${RELEASE_DEBOUNCE_MS}ms`, 3);
}

/** Cancel a pending debounced resume when a run becomes active again. */
export function cancelScheduledResume(): void {
    if (releaseDebounceTimer !== null) {
        logger('syncPause: cancelled scheduled resume (run active again)', 3);
    }
    clearReleaseDebounce();
}

/** Resume Zotero sync immediately. Safe to call repeatedly. */
export function resumeSyncNow(): void {
    clearReleaseDebounce();
    clearSafetyTimer();

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
