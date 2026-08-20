/**
 * Remembers the thread whose agent run was cut off when Beaver closed its
 * WebSocket at shutdown, so the next session can offer to reopen it.
 *
 * Written from the shutdown path (which cannot await anything) and read once
 * on the next start, so the whole record lives in a single JSON preference.
 */
import { getPref, setPref } from "./prefs";

/**
 * Records older than this are ignored. A chat interrupted weeks ago is no
 * longer the work the user was in the middle of.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface InterruptedThread {
    threadId: string;
    /**
     * Beaver account the thread belongs to. The next session may start under a
     * different account, which must not be offered this thread.
     */
    userId: string;
    /** Thread name known at shutdown, if the backend had assigned one. */
    threadName: string | null;
    /** ISO timestamp of the shutdown that interrupted the run. */
    closedAt: string;
}

/**
 * Write the preference, swallowing a failure. Neither writer may throw: one
 * runs inside a shutdown handler, the other inside a React effect whose
 * unmount would take the plugin's global hooks with it.
 */
const writeRecord = (value: string): void => {
    try {
        setPref("interruptedThread", value);
    } catch (error) {
        if (typeof Zotero !== "undefined" && typeof Zotero.logError === "function") {
            Zotero.logError(error as Error);
        }
    }
};

/** Record the interrupted thread, replacing any earlier record. */
export const saveInterruptedThread = (
    record: Omit<InterruptedThread, "closedAt"> & { closedAt?: string },
): void => {
    const stored: InterruptedThread = {
        ...record,
        closedAt: record.closedAt ?? new Date().toISOString(),
    };
    writeRecord(JSON.stringify(stored));
};

/**
 * The recorded thread, or null when there is none, the record is unusable, or
 * it has aged out. Does not clear the preference — the caller clears it once
 * the record has been acted on.
 */
export const getInterruptedThread = (): InterruptedThread | null => {
    const stored = getPref("interruptedThread");
    if (!stored) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(stored);
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Partial<InterruptedThread>;
    if (typeof record.threadId !== "string" || !record.threadId) return null;
    if (typeof record.userId !== "string" || !record.userId) return null;
    if (typeof record.closedAt !== "string") return null;

    const closedAtMs = new Date(record.closedAt).getTime();
    if (!Number.isFinite(closedAtMs) || Date.now() - closedAtMs > MAX_AGE_MS) return null;

    return {
        threadId: record.threadId,
        userId: record.userId,
        threadName: typeof record.threadName === "string" ? record.threadName : null,
        closedAt: record.closedAt,
    };
};

/** Forget the recorded thread. */
export const clearInterruptedThread = (): void => {
    writeRecord("");
};
