import { getPref, setPref } from "./prefs";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 20;
export interface InterruptedThread {
    threadId: string;
    userId: string;
    runId?: string;
    presented?: boolean;
    threadName: string | null;
    closedAt: string;
}
const writeRecords = (records: InterruptedThread[]): void => {
    try {
        setPref(
            "interruptedThread",
            records.length ? JSON.stringify(records) : "",
        );
    } catch (error) {
        if (typeof Zotero !== "undefined") Zotero.logError?.(error as Error);
    }
};
/** Read the bounded list, accepting the single-record preference used by older versions. */
export function getInterruptedThreads(): InterruptedThread[] {
    try {
        const value = JSON.parse(getPref("interruptedThread") || "null");
        return (Array.isArray(value) ? value : [value])
            .filter((record): record is InterruptedThread => {
                if (
                    !record ||
                    typeof record.threadId !== "string" ||
                    !record.threadId ||
                    typeof record.userId !== "string" ||
                    !record.userId ||
                    typeof record.closedAt !== "string"
                )
                    return false;
                const time = Date.parse(record.closedAt);
                return Number.isFinite(time) && Date.now() - time <= MAX_AGE_MS;
            })
            .slice(0, MAX_RECORDS)
            .map((record) => ({
                threadId: record.threadId,
                userId: record.userId,
                ...(typeof record.runId === "string"
                    ? { runId: record.runId }
                    : {}),
                threadName:
                    typeof record.threadName === "string"
                        ? record.threadName
                        : null,
                closedAt: record.closedAt,
                ...(record.presented ? { presented: true } : {}),
            }));
    } catch {
        return [];
    }
}
const sameRecord = (a: InterruptedThread, b: InterruptedThread) =>
    a.userId === b.userId && a.threadId === b.threadId && a.runId === b.runId;
export function saveInterruptedThread(
    record: Omit<InterruptedThread, "closedAt"> & { closedAt?: string },
): void {
    const next = {
        ...record,
        closedAt: record.closedAt ?? new Date().toISOString(),
    };
    const previous = getInterruptedThreads().find((value) =>
        sameRecord(value, next),
    );
    if (previous?.presented) next.presented = true;
    writeRecords(
        [
            next,
            ...getInterruptedThreads().filter(
                (value) => !sameRecord(value, next),
            ),
        ].slice(0, MAX_RECORDS),
    );
}
export const getInterruptedThread = (): InterruptedThread | null =>
    getInterruptedThreads().find((record) => !record.presented) ?? null;
export const clearInterruptedThread = (): void => writeRecords([]);
/** Synchronous consumption admits exactly one presenting surface. */
export function takeInterruptedThread(
    userId: string,
): InterruptedThread | null {
    const records = getInterruptedThreads().filter(
        (record) => record.userId === userId,
    );
    const record = records.find((value) => !value.presented) ?? null;
    if (record) {
        record.presented = true;
        writeRecords(records);
    }
    return record;
}
