/**
 * Background PDF discovery for items Beaver created: find a PDF for a new item
 * and report the outcome as an `attachment_resolved` event.
 *
 * Esbuild-safe: no `react/*` imports, no bare `addon`.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { generateTaskId, scheduleBackgroundTask } from '../../utils/backgroundTasks';
import { buildPdfResolvers, type PdfFetchOptions } from '../../utils/pdfResolvers';
import { fetchPdfAttachment } from '../pdfAttachmentFetch';

/**
 * Filter attachment IDs to return only PDF attachments.
 */
export async function filterPdfAttachments(attachmentIds: number[]): Promise<Zotero.Item[]> {
    if (!attachmentIds || attachmentIds.length === 0) return [];
    
    const attachments = await Promise.all(
        attachmentIds.map(id => Zotero.Items.getAsync(id))
    );
    
    return attachments.filter((a): a is Zotero.Item => 
        a && !a.deleted && a.isPDFAttachment()
    );
}

/** Schedule PDF discovery outside the mutation queue and coordinate only its attachment save. */
export function schedulePdfFetchTask(
    libraryId: number,
    itemKey: string,
    options: PdfFetchOptions
): void {
    const taskId = generateTaskId('pdf_fetch', libraryId, itemKey);
    const generation = Zotero.Beaver.account?.getGeneration();
    const assertAccess = () => {
        const library = Zotero.Libraries.get(libraryId);
        if (generation !== Zotero.Beaver.account?.getGeneration()) throw new Error('Account changed');
        if (!Zotero.Beaver.libraryScopeInitialized || !Zotero.Beaver.searchableLibraryIds?.includes(libraryId)
            || !library || !library.editable || library.filesEditable === false) {
            throw new Error('Library is excluded or unavailable');
        }
    };

    scheduleBackgroundTask(
        taskId,
        'pdf_fetch',
        async (signal: AbortSignal) => {
            const startedAt = Date.now();
            let item: Zotero.Item | null = null;
            let attachedPdf: Zotero.Item | null = null;
            let accessMethod: string | undefined;
            // Set when the attachment came from the fetch rather than from the
            // re-check below, which is the only case where `accessMethod`
            // describes the file we ended up with.
            let attachedByFetch = false;

            try {
                assertAccess();
                const fetched = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, itemKey);
                if (!fetched) {
                    throw new Error(`Item not found: ${libraryId}-${itemKey}`);
                }
                item = fetched;

                // Check if cancelled or PDF was attached in the meantime
                if (signal.aborted) return;
                const attachmentIds = await item.getAttachments();
                const pdfAttachments = await filterPdfAttachments(attachmentIds);
                if (pdfAttachments.length > 0) {
                    logger(`schedulePdfFetchTask: Item already has PDF, skipping`, 2);
                    // Capture for the finally so we emit `available`. The PDF
                    // may have been attached out-of-band (e.g. translator) and
                    // the backend may still have us marked `pending`.
                    attachedPdf = pdfAttachments[0];
                    return;
                }

                const resolvers = buildPdfResolvers(item, options);
                if (resolvers.length === 0) {
                    logger(`schedulePdfFetchTask: No resolvers for ${itemKey}`, 2);
                    return;
                }

                logger(`schedulePdfFetchTask: Trying ${resolvers.length} resolvers for ${itemKey}`, 2);
                const outcome = await fetchPdfAttachment(item, resolvers, signal, assertAccess);
                if (outcome.attachment) {
                    attachedPdf = outcome.attachment;
                    accessMethod = outcome.accessMethod;
                    attachedByFetch = !!accessMethod;
                    logger(`schedulePdfFetchTask: Attached PDF via ${accessMethod ?? 'existing'}`, 2);
                }

                if (signal.aborted) return;


            } catch (e: any) {
                // Early failure path (e.g. item lookup threw). attachedPdf
                // stays null so finally emits `failed`.
                logger(
                    `schedulePdfFetchTask: ${itemKey} task body threw: ${e?.message || e}`,
                    1,
                );
            } finally {
                // Always emit the attachment_resolved ws event
                if (!signal.aborted && generation === Zotero.Beaver.account?.getGeneration()
                    && Zotero.Beaver.searchableLibraryIds?.includes(libraryId)) {
                    // If we don't yet have a PDF, re-check attachments: a
                    // translator can save one out of band.
                    if (!attachedPdf && item) {
                        try {
                            const currentAttachmentIds = await item.getAttachments();
                            const currentPdfs = await filterPdfAttachments(currentAttachmentIds);
                            if (currentPdfs.length > 0) {
                                attachedPdf = currentPdfs[0];
                                logger(
                                    `schedulePdfFetchTask: Re-check found PDF for ${itemKey} (key=${attachedPdf.key})`,
                                    2,
                                );
                            }
                        } catch (e: any) {
                            logger(
                                `schedulePdfFetchTask: Re-check getAttachments failed for ${itemKey}: ${e?.message || e}`,
                                2,
                            );
                        }
                    }

                    if (!signal.aborted && generation === Zotero.Beaver.account?.getGeneration()
                        && Zotero.Beaver.searchableLibraryIds?.includes(libraryId)) {
                        options.onAttachmentResolved?.({
                            threadId: options.threadId,
                            actionId: options.actionId,
                            libraryId,
                            zoteroKey: itemKey,
                            attachmentStatus: attachedPdf ? 'available' : 'failed',
                            attachmentKey: attachedPdf ? `${libraryId}-${attachedPdf.key}` : undefined,
                            accessMethod: attachedByFetch ? accessMethod : undefined,
                            elapsedMs: Date.now() - startedAt,
                        });
                    }
                }
            }
        },
        {
            itemKey,
            libraryId,
            progressMessage: 'Finding PDF...',
        }
    );
}
