import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { embeddingIndexStateAtom, EmbeddingIndexState } from '../atoms/embeddingIndex';
import { addPopupMessageAtom, updatePopupMessageAtom, removePopupMessageAtom } from '../utils/popupMessageUtils';
import { planFeaturesAtom } from '../atoms/profile';

const EMBEDDING_INDEXING_POPUP_ID = 'embedding-indexing-progress';

/**
 * Hook that shows a popup with progress during embedding indexing.
 * - Shows popup when indexing starts (initial phase only)
 * - Updates progress in real-time
 * - Auto-dismisses when complete or after timeout
 */
export function useEmbeddingIndexProgress() {
    const indexState = useAtomValue(embeddingIndexStateAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);
    const updatePopupMessage = useSetAtom(updatePopupMessageAtom);
    const removePopupMessage = useSetAtom(removePopupMessageAtom);
    const planFeatures = useAtomValue(planFeaturesAtom);
    
    // Track if we've shown the popup for this indexing session
    const hasShownPopupRef = useRef(false);
    const previousStatusRef = useRef<EmbeddingIndexState['status']>('idle');

    useEffect(() => {
        // Remove popup if user upgrades to databaseSync plan
        if (planFeatures.databaseSync) {
            removePopupMessage(EMBEDDING_INDEXING_POPUP_ID);
            return;
        }
        const { status, phase, progress, totalItems, indexedItems } = indexState;
        const prevStatus = previousStatusRef.current;

        // Only show popup for initial indexing phase with items to index
        const shouldShowPopup = status === 'indexing' && phase === 'initial' && totalItems > 0;

        // Detect transition from idle to indexing - this is a new indexing session
        if (prevStatus === 'idle' && status === 'indexing' && phase === 'initial') {
            hasShownPopupRef.current = false;
        }

        // Show popup when indexing starts
        if (shouldShowPopup && !hasShownPopupRef.current) {
            hasShownPopupRef.current = true;
            addPopupMessage({
                id: EMBEDDING_INDEXING_POPUP_ID,
                type: 'embedding_indexing',
                title: 'Building Search Index',
                text: `Indexing ${indexedItems.toLocaleString()}/${totalItems.toLocaleString()} items. Search limited until complete.`,
                progress: progress,
                expire: false, // Don't auto-expire while indexing
                cancelable: false,
            });
        }
        // Update progress while indexing
        else if (shouldShowPopup && hasShownPopupRef.current) {
            updatePopupMessage({
                messageId: EMBEDDING_INDEXING_POPUP_ID,
                updates: {
                    progress: progress,
                    text: `Indexing ${indexedItems.toLocaleString()}/${totalItems.toLocaleString()} items. Search limited until complete.`,
                    cancelable: false,
                },
            });
        }
        // Indexing complete - update message and schedule dismissal
        else if (prevStatus === 'indexing' && status === 'idle' && hasShownPopupRef.current) {
            updatePopupMessage({
                messageId: EMBEDDING_INDEXING_POPUP_ID,
                updates: {
                    title: 'Search Index Ready',
                    text: `${indexedItems.toLocaleString()} items indexed`,
                    progress: 100,
                    expire: true,
                    duration: 3500, // Dismiss after 3.5 seconds
                    cancelable: true,
                },
            });
            hasShownPopupRef.current = false;
        }
        // Error state - update message
        else if (status === 'error' && hasShownPopupRef.current) {
            updatePopupMessage({
                messageId: EMBEDDING_INDEXING_POPUP_ID,
                updates: {
                    title: 'Search Index Error',
                    text: indexState.error || 'Failed to build search index',
                    expire: true,
                    duration: 4000,
                    cancelable: true,
                },
            });
            hasShownPopupRef.current = false;
        }

        // Update previous status for next comparison
        previousStatusRef.current = status;
    }, [indexState, planFeatures, addPopupMessage, updatePopupMessage, removePopupMessage]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            removePopupMessage(EMBEDDING_INDEXING_POPUP_ID);
        };
    }, [removePopupMessage]);
}

