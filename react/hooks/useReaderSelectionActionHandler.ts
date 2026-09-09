/**
 * Hook that listens for "readerSelectionAction" events dispatched from the
 * esbuild bundle's reader integration and orchestrates the sidebar-open →
 * new-thread → set-text-selection → send-message / focus-input flow.
 */

import { beginReaderActionThread } from '../utils/beginReaderActionThread';

import { useSetAtom } from 'jotai';
import { userAtom } from '../atoms/auth';
import { newThreadAtom } from '../atoms/threads';
import { readerActionContextAtom, addItemsToCurrentMessageItemsAtom } from '../atoms/messageComposition';
import { sendWSMessageAtom } from '../atoms/agentRunAtoms';
import { eventManager } from '../events/eventManager';
import { useEventSubscription } from './useEventSubscription';
import { store } from '../store';
import { logger } from '@beaver/agent-core/platform/logger';
import { getPref } from '../../src/utils/prefs';

export function useReaderSelectionActionHandler() {
    const newThread = useSetAtom(newThreadAtom);
    const setReaderActionContext = useSetAtom(readerActionContextAtom);
    const addItems = useSetAtom(addItemsToCurrentMessageItemsAtom);
    const sendWSMessage = useSetAtom(sendWSMessageAtom);

    useEventSubscription('readerSelectionAction', async (detail) => {
        const { action, text, page, readerItemID, readerLocation } = detail;

        // Skip if not authenticated
        if (!store.get(userAtom)) return;

        logger(`useReaderSelectionActionHandler: Received action "${action}" for item ${readerItemID}`);

        // 1. Open sidebar
        eventManager.dispatch('toggleChat', { forceOpen: true, skipAutoPopulate: true });

        // 2. New thread
        const isCurrent = await beginReaderActionThread(newThread);
        if (!isCurrent) return;

        // 3. Set text selection and send message (after sidebar-open state settles)
        setTimeout(async () => {
            try {
                if (!isCurrent()) return;
                const item = await Zotero.Items.getAsync(readerItemID);
                if (!item) return;
                if (!isCurrent()) return;
                await addItems([item]);
                if (!isCurrent()) return;
                setReaderActionContext({ item, selection: text ? { text, page } : null, location: readerLocation });

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
    }, [newThread, setReaderActionContext, addItems, sendWSMessage]);
}
