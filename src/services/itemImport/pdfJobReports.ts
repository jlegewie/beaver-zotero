/**
 * How the fetch tasks (PDF discovery, web snapshot, attach-in-order) tell the
 * PDF job registry (`Zotero.Beaver.pdfJobs`) that a fetch started and settled.
 * Only fetches of agent-created items (those with an action id) are tracked.
 */

import type { AttachmentResolvedPayload } from '../attachmentResolved';

/**
 * Tell the PDF job registry a tracked fetch settled. A no-op for a fetch that
 * was not tracked (no action id) or when the registry is not running.
 */
export function reportFetchSettled(
    options: { actionId?: string },
    resolved: Pick<
        AttachmentResolvedPayload,
        'actionId' | 'libraryId' | 'zoteroKey' | 'attachmentStatus' | 'attachmentKey' | 'accessMethod' | 'failureReason' | 'elapsedMs'
    >,
): void {
    if (!options.actionId) return;
    Zotero.Beaver?.pdfJobs?.fetchSettled({
        actionId: resolved.actionId,
        libraryId: resolved.libraryId,
        zoteroKey: resolved.zoteroKey,
        attachmentStatus: resolved.attachmentStatus,
        attachmentKey: resolved.attachmentKey,
        accessMethod: resolved.accessMethod,
        failureReason: resolved.failureReason,
        elapsedMs: resolved.elapsedMs,
    });
}

/** Tell the registry a tracked fetch started; `taskId` lets the job cancel it. */
export function reportFetchStarted(
    options: { actionId?: string; threadId?: string | null },
    libraryId: number,
    zoteroKey: string,
    taskId: string,
): void {
    if (!options.actionId) return;
    Zotero.Beaver?.pdfJobs?.fetchStarted({
        actionId: options.actionId,
        threadId: options.threadId,
        libraryId,
        zoteroKey,
        taskId,
    });
}
