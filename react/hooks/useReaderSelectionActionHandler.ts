/**
 * Hook that listens for "readerSelectionAction" events dispatched from the
 * esbuild bundle's reader integration and orchestrates the sidebar-open →
 * new-thread → set-text-selection → send-message / focus-input flow.
 */

import { useSetAtom, useAtomValue } from 'jotai';
import { userAtom } from '../atoms/auth';
import { newThreadAtom } from '../atoms/threads';
import { readerTextSelectionAtom, currentReaderAttachmentAtom } from '../atoms/messageComposition';
import { sendWSMessageAtom } from '../atoms/agentRunAtoms';
import { eventManager } from '../events/eventManager';
import { useEventSubscription } from './useEventSubscription';
import { store } from '../store';
import { logger } from '../../src/utils/logger';
import { getPref } from '../../src/utils/prefs';

export function useReaderSelectionActionHandler() {
    const user = useAtomValue(userAtom);
    const newThread = useSetAtom(newThreadAtom);
    const setReaderTextSelection = useSetAtom(readerTextSelectionAtom);
    const setReaderAttachment = useSetAtom(currentReaderAttachmentAtom);
    const sendWSMessage = useSetAtom(sendWSMessageAtom);

    useEventSubscription('readerSelectionAction', async (detail) => {
        const { action, text, page, readerItemID } = detail;

        logger(`useReaderSelectionActionHandler: Received action "${action}" for item ${readerItemID}`);

        // 1. Open sidebar
        eventManager.dispatch('toggleChat', { forceOpen: true, skipAutoPopulate: true });

        // 2. New thread
        await newThread({ skipAutoPopulate: true });

        // 3. Set text selection and send message (after sidebar-open state settles)
        setTimeout(async () => {
            try {
                // Set text selection
                setReaderTextSelection({ text, page });

                // Ensure reader attachment is set
                const readerAttachment = store.get(currentReaderAttachmentAtom);
                if (!readerAttachment || readerAttachment.id !== readerItemID) {
                    const item = await Zotero.Items.getAsync(readerItemID);
                    if (item) setReaderAttachment(item);
                }

                // Either send explain prompt or focus input
                if (action === 'explain') {
                    const defaultPrompt = 'Explain the selected passage from this paper in plain language. '
                        + 'Provide context for any technical terms, statistical methods, or domain-specific concepts. '
                        + 'If it references other work, briefly explain that context too.';
                    const prompt = getPref('readerExplainPrompt') || defaultPrompt;
                    await sendWSMessage(prompt);
                } else {
                    // Focus the input textarea for "Ask..."
                    eventManager.dispatch('focusInput', {});
                }
            } catch (error) {
                logger(`useReaderSelectionActionHandler: Error: ${error}`, 1);
            }
        }, 0);
    }, [user, newThread, setReaderTextSelection, setReaderAttachment, sendWSMessage]);
}
