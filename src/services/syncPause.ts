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
}

/** Cancel a pending debounced resume when a run becomes active again. */
export function cancelScheduledResume(): void {
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
    } catch (err) {
        logger('Zotero sync resume failed', { error: String(err) }, 1);
    }
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
