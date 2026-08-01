/**
 * Hook that listens for "contextMenuAction" events dispatched from the esbuild
 * bundle's MenuManager integration and orchestrates the sidebar-open → new-thread
 * → set-items → stage-action-pill flow. The user submits the message themselves.
 */

import { useSetAtom, useAtomValue } from 'jotai';
import { userAtom } from '../atoms/auth';
import { searchableLibraryIdsAtom } from '../atoms/profile';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { newThreadAtom } from '../atoms/threads';
import { currentMessageItemsAtom, currentMessageCollectionsAtom } from '../atoms/messageComposition';
import { collectionToReference, CollectionReference } from '../types/zotero';
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
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);

    useEventSubscription('contextMenuAction', async (detail) => {
        const { actionId, actionTitle, targetType, itemIds, collections } = detail;

        // Library exclusion is a read boundary: drop excluded collections using
        // the library ID the event carries, before any Zotero lookup, and never
        // stage them into the composer.
        const allowedCollections = collections.filter(c => searchableLibraryIds.includes(c.libraryId));
        if (targetType === 'collection' && collections.length > 0 && allowedCollections.length === 0) {
            addPopupMessage({
                type: 'error',
                title: 'Action skipped',
                text: 'This action targets a collection in a library you excluded from Beaver. You can change excluded libraries in Beaver Preferences.',
                expire: true,
                duration: 5000,
            });
            return;
        }

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
                // Target context for the action's prompt: the rows the user
                // right-clicked, which are not always what the live Zotero
                // selection resolves to (e.g. with a reader tab open).
                let contextItems: Zotero.Item[] = [];
                if (itemIds.length > 0) {
                    const items = await Zotero.Items.getAsync(itemIds);
                    if (items.length > 0) {
                        // Multi-target actions can dispatch mixed selections,
                        // so check the items themselves for notes
                        const dataTypes = items.some(i => i.isNote())
                            ? ['itemData', 'note']
                            : ['itemData'];
                        await Zotero.Items.loadDataTypes(items, dataTypes);
                        setCurrentMessageItems(items);
                        contextItems = items;
                    }
                } else {
                    // Collection/global actions: clear any items auto-populated
                    // from Zotero selection by useZoteroContext
                    setCurrentMessageItems([]);
                }

                // For collection actions: explicitly attach every right-clicked
                // collection the user can use, so the model receives the whole
                // allowed selection.
                let contextCollections: CollectionReference[] = [];
                if (targetType === 'collection' && allowedCollections.length > 0) {
                    const cols = allowedCollections
                        .map(c => Zotero.Collections.get(c.collectionId) as Zotero.Collection | undefined)
                        .filter((col): col is Zotero.Collection => !!col);
                    if (cols.length > 0) {
                        contextCollections = cols.map(collectionToReference);
                        setCurrentMessageCollections(contextCollections);
                    }
                }

                // 4. Stage the action as a /command pill in the input, bound to
                //    the right-clicked rows. The context menu / reader toolbar
                //    live in the main window and step 1 force-opened its
                //    sidebar, so target that editor (not the separate Beaver
                //    window, if one is open).
                stageActionPill({
                    actionId,
                    targetType,
                    fallbackTitle: actionTitle,
                    contextOverride: { items: contextItems, collections: contextCollections },
                    targetWindow: Zotero.getMainWindow(),
                });
            } catch (error) {
                logger(`useContextMenuActionHandler: Error executing action: ${error}`, 1);
            }
        }, 0);
    }, [user, newThread, setCurrentMessageItems, setCurrentMessageCollections, stageActionPill,
        searchableLibraryIds, addPopupMessage]);
}
