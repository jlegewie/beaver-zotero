/**
 * Hook that listens for "contextMenuAction" events dispatched from the esbuild
 * bundle's MenuManager integration and orchestrates the sidebar-open → new-thread
 * → set-items → stage-action-pill flow. The user submits the message themselves.
 */

import { useSetAtom, useAtomValue } from 'jotai';
import { userAtom } from '../atoms/auth';
import { newThreadAtom } from '../atoms/threads';
import { currentMessageItemsAtom, currentMessageCollectionsAtom } from '../atoms/messageComposition';
import { collectionToReference } from '../types/zotero';
import { stageActionPillAtom } from '../atoms/actions';
import { eventManager } from '../events/eventManager';
import { useEventSubscription } from './useEventSubscription';
import { logger } from '../../src/utils/logger';

export function useContextMenuActionHandler() {
    const user = useAtomValue(userAtom);
    const newThread = useSetAtom(newThreadAtom);
    const setCurrentMessageItems = useSetAtom(currentMessageItemsAtom);
    const setCurrentMessageCollections = useSetAtom(currentMessageCollectionsAtom);
    const stageActionPill = useSetAtom(stageActionPillAtom);

    useEventSubscription('contextMenuAction', async (detail) => {
        const { actionId, actionTitle, targetType, itemIds, collectionId } = detail;

        logger(`useContextMenuActionHandler: Received action ${actionId} (${targetType}), ${itemIds.length} items`);

        // 1. Open sidebar (skip auto-populate — we manage items ourselves)
        eventManager.dispatch('toggleChat', { forceOpen: true, skipAutoPopulate: true });

        // 2. Start new thread (clears current thread state + message items)
        //    Skip auto-populate — we manage items/collection ourselves below
        await newThread({ skipAutoPopulate: true });

        // 3. Load items/collection and set on the message
        //    Use setTimeout(0) to let the sidebar-open state settle
        //    (toggleChat's synchronous clear of items runs in the same tick)
        setTimeout(async () => {
            try {
                if (itemIds.length > 0) {
                    const items = await Zotero.Items.getAsync(itemIds);
                    if (items.length > 0) {
                        const dataTypes = targetType === 'note'
                            ? ['itemData', 'note']
                            : ['itemData'];
                        await Zotero.Items.loadDataTypes(items, dataTypes);
                        setCurrentMessageItems(items);
                    }
                } else {
                    // Collection/global actions: clear any items auto-populated
                    // from Zotero selection by useZoteroContext
                    setCurrentMessageItems([]);
                }

                // For collection actions: explicitly attach the right-clicked collection
                if (targetType === 'collection' && collectionId) {
                    const col = Zotero.Collections.get(collectionId);
                    if (col) {
                        setCurrentMessageCollections([collectionToReference(col)]);
                    }
                }

                // 4. Stage the action as a /command pill in the input. The
                //    context menu / reader toolbar live in the main window and
                //    step 1 force-opened its sidebar, so target that editor
                //    (not the separate Beaver window, if one is open).
                stageActionPill({
                    actionId,
                    targetType,
                    fallbackTitle: actionTitle,
                    targetWindow: Zotero.getMainWindow(),
                });
            } catch (error) {
                logger(`useContextMenuActionHandler: Error executing action: ${error}`, 1);
            }
        }, 0);
    }, [user, newThread, setCurrentMessageItems, setCurrentMessageCollections, stageActionPill]);
}
