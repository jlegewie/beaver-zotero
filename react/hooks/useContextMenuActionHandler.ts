/**
 * Hook that listens for "contextMenuAction" events dispatched from the esbuild
 * bundle's MenuManager integration and orchestrates the sidebar-open → new-thread
 * → set-items → send-action flow.
 */

import { useSetAtom, useAtomValue } from 'jotai';
import { userAtom } from '../atoms/auth';
import { newThreadAtom } from '../atoms/threads';
import { currentMessageItemsAtom } from '../atoms/messageComposition';
import { sendResolvedActionAtom, markActionUsedAtom } from '../atoms/actions';
import { eventManager } from '../events/eventManager';
import { useEventSubscription } from './useEventSubscription';
import { logger } from '../../src/utils/logger';

export function useContextMenuActionHandler() {
    const user = useAtomValue(userAtom);
    const newThread = useSetAtom(newThreadAtom);
    const setCurrentMessageItems = useSetAtom(currentMessageItemsAtom);
    const sendResolvedAction = useSetAtom(sendResolvedActionAtom);
    const markActionUsed = useSetAtom(markActionUsedAtom);

    useEventSubscription('contextMenuAction', async (detail) => {
        const { actionId, actionText, targetType, itemIds, collectionId } = detail;

        logger(`useContextMenuActionHandler: Received action ${actionId} (${targetType}), ${itemIds.length} items`);

        // 1. Open sidebar
        eventManager.dispatch('toggleChat', { forceOpen: true });

        // 2. Start new thread (clears current thread state + message items)
        await newThread();

        // 3. Load items from IDs and set on the message
        //    Use setTimeout(0) to let the sidebar-open state settle
        //    (toggleChat's synchronous clear of items runs in the same tick)
        setTimeout(async () => {
            try {
                if (itemIds.length > 0) {
                    const items = await Zotero.Items.getAsync(itemIds);
                    if (items.length > 0) {
                        await Zotero.Items.loadDataTypes(items, ['itemData']);
                        setCurrentMessageItems(items);
                    }
                } else {
                    // Collection/global actions: clear any items auto-populated
                    // from Zotero selection by useZoteroContext
                    setCurrentMessageItems([]);
                }

                // 4. Send the action
                await sendResolvedAction({ text: actionText, targetType });

                // 5. Mark as used
                markActionUsed(actionId);
            } catch (error) {
                logger(`useContextMenuActionHandler: Error executing action: ${error}`, 1);
            }
        }, 0);
    }, [user, newThread, setCurrentMessageItems, sendResolvedAction, markActionUsed]);
}
