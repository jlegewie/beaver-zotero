/**
 * Attaching the files an import proposal names, in the proposal's order.
 *
 * A record that knows its files (a trial's protocol and statistical analysis
 * plan) lists them in `attachments`. They are downloaded through the same
 * controlled path as PDF discovery (no CAPTCHA window, the user's filename
 * template, source URL and title kept on the attachment) and saved in list
 * order, so the first file becomes the item's best attachment, the one a
 * double-click opens.
 *
 * Zotero orders a parent's attachments by content type, then by whether the
 * attachment's URL equals the parent's, then by `dateAdded` (stored to the
 * second). Every file here is a PDF whose URL differs from the parent's, so
 * `dateAdded` decides; files saved within the same second would tie, which is
 * why each save is pushed at least one second past the previous one.
 *
 * Esbuild-safe: no `react/*` imports, no bare `addon`.
 */

import type { ImportAttachment } from '@beaver/agent-core/types/itemImport';
import { logger } from '@beaver/agent-core/platform/logger';
import { generateTaskId, scheduleBackgroundTask } from '../../utils/backgroundTasks';
import { coordinateLibraryMutation } from '../libraryMutations';
import { runCommittedTransaction } from '../committedTransaction';
import type { AttachmentResolvedPayload } from '../attachmentResolved';
import {
    discardDownloadedFile,
    downloadAttachmentFile,
    saveDownloadedAttachment,
    type DownloadedFile,
} from '../pdfAttachmentFetch';
import { PDF_FETCH_CANCELLED_MESSAGE } from '../pdfFetchDiagnostics';

/** Reported as the access method of a file the record named. */
export const RECORD_ACCESS_METHOD = 'record';

export interface AttachInOrderResult {
    /** The first file that was attached: the item's best attachment. */
    primary: Zotero.Item | null;
    attached: Zotero.Item[];
}

/** `dateAdded` (UTC "YYYY-MM-DD HH:MM:SS") as epoch milliseconds, or null. */
function dateAddedMs(item: Zotero.Item): number | null {
    const value = item.dateAdded as unknown as string | undefined;
    if (!value) return null;
    const date = (Zotero.Date as any).sqlToDate(value, true) as Date | false;
    return date ? date.getTime() : null;
}

/** Push `attachment`'s `dateAdded` past `previousMs` when it does not already follow it. */
async function orderAfter(attachment: Zotero.Item, previousMs: number | null): Promise<number | null> {
    const current = dateAddedMs(attachment);
    if (previousMs === null || (current !== null && current > previousMs)) return current;
    const next = new Date(previousMs + 1000);
    attachment.setField('dateAdded', (Zotero.Date as any).dateToSQL(next, true));
    await runCommittedTransaction(() => attachment.save({ skipDateModifiedUpdate: true } as any), {
        label: 'attachInOrder dateAdded',
    });
    return next.getTime();
}

function attachmentTitle(attachment: ImportAttachment, index: number): string {
    const title = attachment.title?.trim();
    if (title) return title;
    return index === 0 ? Zotero.getString('attachment.fullText') : `Document ${index + 1}`;
}

/**
 * Download every attachment (concurrently) and save them as children of
 * `parent` in list order. A file that fails is skipped; the next one that
 * succeeds becomes the primary.
 */
export async function attachInOrder(
    parent: Zotero.Item,
    attachments: ImportAttachment[],
    signal: AbortSignal,
    assertAccess: () => void,
): Promise<AttachInOrderResult> {
    const assertCurrent = () => {
        if (signal.aborted) throw new Error(PDF_FETCH_CANCELLED_MESSAGE);
        assertAccess();
    };
    const downloads: Array<DownloadedFile | null> = await Promise.all(attachments.map(async (attachment) => {
        try {
            return await downloadAttachmentFile(
                [{ url: attachment.url, accessMethod: RECORD_ACCESS_METHOD }],
                signal,
                assertAccess,
            );
        } catch (error) {
            logger(`itemImport/attachInOrder: download of ${attachment.url} failed: ${error}`, 1);
            return null;
        }
    }));

    const attached: Zotero.Item[] = [];
    let previousMs: number | null = null;
    try {
        for (let index = 0; index < attachments.length; index++) {
            const file = downloads[index];
            if (!file) continue;
            assertCurrent();
            // The save consumes the directory, whether it succeeds or not.
            downloads[index] = null;
            let attachment: Zotero.Item;
            try {
                ({ attachment } = await saveDownloadedAttachment(parent, file, {
                    title: attachmentTitle(attachments[index], index),
                    signal,
                    assertCurrent,
                }));
            } catch (error) {
                if (signal.aborted) throw error;
                logger(`itemImport/attachInOrder: saving ${attachments[index].url} failed: ${error}`, 1);
                continue;
            }
            attached.push(attachment);
            if (previousMs === null) {
                previousMs = dateAddedMs(attachment);
                continue;
            }
            try {
                previousMs = await coordinateLibraryMutation(
                    () => orderAfter(attachment, previousMs),
                    { signal, assertCurrent },
                );
            } catch (error) {
                if (signal.aborted) throw error;
                logger(`itemImport/attachInOrder: ordering ${attachment.key} after the previous file failed: ${error}`, 1);
            }
        }
    } finally {
        await Promise.all(downloads.map((file) => discardDownloadedFile(file)));
    }
    return { primary: attached[0] ?? null, attached };
}

export interface AttachInOrderTaskOptions {
    actionId?: string;
    runId?: string;
    threadId?: string;
    onAttachmentResolved?: (payload: AttachmentResolvedPayload) => void;
}

/**
 * Attach `attachments` to a new item in the background and report the
 * primary file as an `attachment_resolved` event.
 */
export function scheduleAttachInOrderTask(
    libraryId: number,
    itemKey: string,
    attachments: ImportAttachment[],
    options: AttachInOrderTaskOptions,
): void {
    const generation = Zotero.Beaver.account?.getGeneration();
    const assertAccess = () => {
        const library = Zotero.Libraries.get(libraryId);
        if (generation !== Zotero.Beaver.account?.getGeneration()) throw new Error('Account changed');
        if (!Zotero.Beaver.libraryScopeInitialized || !Zotero.Beaver.searchableLibraryIds?.includes(libraryId)
            || !library || !library.editable || library.filesEditable === false) {
            throw new Error('Library is excluded or unavailable');
        }
    };

    scheduleBackgroundTask(generateTaskId('pdf_fetch', libraryId, itemKey), 'pdf_fetch', async (signal: AbortSignal) => {
        const startedAt = Date.now();
        let primary: Zotero.Item | null = null;
        try {
            assertAccess();
            const parent = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, itemKey);
            if (!parent) throw new Error(`Item not found: ${libraryId}-${itemKey}`);
            ({ primary } = await attachInOrder(parent, attachments, signal, assertAccess));
        } catch (error: any) {
            logger(`itemImport/attachInOrder: ${itemKey} failed: ${error?.message || error}`, 1);
        } finally {
            if (!signal.aborted && generation === Zotero.Beaver.account?.getGeneration()
                && Zotero.Beaver.searchableLibraryIds?.includes(libraryId)) {
                const attachment = primary as Zotero.Item | null;
                options.onAttachmentResolved?.({
                    threadId: options.threadId,
                    actionId: options.actionId,
                    libraryId,
                    zoteroKey: itemKey,
                    attachmentStatus: attachment ? 'available' : 'failed',
                    attachmentKey: attachment ? `${libraryId}-${attachment.key}` : undefined,
                    accessMethod: attachment ? RECORD_ACCESS_METHOD : undefined,
                    elapsedMs: Date.now() - startedAt,
                    failureReason: attachment ? undefined : 'error',
                });
            }
        }
    }, { itemKey, libraryId, progressMessage: 'Attaching documents...' });
}
