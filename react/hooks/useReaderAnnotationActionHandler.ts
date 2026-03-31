/**
 * Hook that listens for "readerAnnotationAction" events dispatched from the
 * esbuild bundle's reader integration and orchestrates the sidebar-open →
 * new-thread → add-annotations-to-message → send-message / focus-input flow.
 */

import { useSetAtom } from 'jotai';
import { userAtom } from '../atoms/auth';
import { newThreadAtom } from '../atoms/threads';
import { currentReaderAttachmentAtom, addItemsToCurrentMessageItemsAtom } from '../atoms/messageComposition';
import { sendWSMessageAtom } from '../atoms/agentRunAtoms';
import { eventManager } from '../events/eventManager';
import { useEventSubscription } from './useEventSubscription';
import { store } from '../store';
import { logger } from '../../src/utils/logger';
import { getPref } from '../../src/utils/prefs';

export function useReaderAnnotationActionHandler() {
    const newThread = useSetAtom(newThreadAtom);
    const setReaderAttachment = useSetAtom(currentReaderAttachmentAtom);
    const addItems = useSetAtom(addItemsToCurrentMessageItemsAtom);
    const sendWSMessage = useSetAtom(sendWSMessageAtom);

    useEventSubscription('readerAnnotationAction', async (detail) => {
        const { action, annotationIds, readerItemID } = detail;

        // Skip if not authenticated
        if (!store.get(userAtom)) return;

        logger(`useReaderAnnotationActionHandler: Received action "${action}" for ${annotationIds.length} annotation(s)`);

        // 1. Open sidebar
        eventManager.dispatch('toggleChat', { forceOpen: true, skipAutoPopulate: true });

        // 2. New thread
        await newThread({ skipAutoPopulate: true });

        // 3. Load annotation items, add to message, and send/focus
        setTimeout(async () => {
            try {
                // Resolve the attachment (also used for libraryID in key lookups below)
                const attachment = await Zotero.Items.getAsync(readerItemID);
                if (!attachment) {
                    logger('useReaderAnnotationActionHandler: Could not resolve reader item', 1);
                    return;
                }

                // Ensure reader attachment is set
                const readerAttachment = store.get(currentReaderAttachmentAtom);
                if (!readerAttachment || readerAttachment.id !== readerItemID) {
                    setReaderAttachment(attachment);
                }

                // Load annotation Zotero.Items by key
                const annotationItems: Zotero.Item[] = [];
                for (const key of annotationIds) {
                    const item = await Zotero.Items.getByLibraryAndKeyAsync(
                        attachment.libraryID,
                        key,
                    );
                    if (item) {
                        annotationItems.push(item);
                    } else {
                        logger(`useReaderAnnotationActionHandler: Could not find annotation with key ${key}`, 2);
                    }
                }

                if (annotationItems.length === 0) {
                    logger('useReaderAnnotationActionHandler: No valid annotation items found', 1);
                    return;
                }

                // Add annotations to current message items
                await addItems(annotationItems);

                if (action === 'explain') {
                    const defaultPrompt = 'Explain the selected annotation(s) from this paper in plain language. '
                        + 'Provide context for any technical terms, statistical methods, or domain-specific concepts. '
                        + 'If it references other work, briefly explain that context too.';
                    const prompt = getPref('readerExplainPrompt') || defaultPrompt;
                    await sendWSMessage(prompt);
                } else {
                    // Focus the input textarea for "Ask..."
                    eventManager.dispatch('focusInput', {});
                }
            } catch (error) {
                logger(`useReaderAnnotationActionHandler: Error: ${error}`, 1);
            }
        }, 0);
    }, [newThread, setReaderAttachment, addItems, sendWSMessage]);
}
