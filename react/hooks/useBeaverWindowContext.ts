/**
 * Context wiring for the separate Beaver window.
 *
 * The window renders with the main window's React instance and shares its Jotai
 * store, so it has no lifecycle of its own beyond this component tree. This hook
 * gives it one:
 *
 * 1. Publishes `isBeaverWindowOpenAtom`, which makes `isBeaverUIVisibleAtom`
 *    true. Shared context tracking (`useReaderTabSelection`) keys off that, so
 *    the current reader attachment, its page, and the reader text selection are
 *    tracked while the window is the only open Beaver surface.
 * 2. Stages the current Zotero selection on open, mirroring what
 *    `useToggleSidebar` does when the sidebar is opened.
 */

import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { store } from '../store';
import { getPref } from '../../src/utils/prefs';
import {
    isBeaverWindowOpenAtom,
    isLibraryTabAtom,
    isSidebarVisibleAtom,
    removePopupMessagesByTypeAtom,
} from '../atoms/ui';
import {
    currentMessageItemsAtom,
    updateMessageItemsFromZoteroSelectionAtom,
} from '../atoms/messageComposition';
import { isProfileLoadedAtom } from '../atoms/profile';
import { logger } from '@beaver/agent-core/platform/logger';

export function useBeaverWindowContext() {
    const setIsBeaverWindowOpen = useSetAtom(isBeaverWindowOpenAtom);
    const isProfileLoaded = useAtomValue(isProfileLoadedAtom);
    const updateMessageItemsFromZoteroSelection = useSetAtom(updateMessageItemsFromZoteroSelectionAtom);
    const setCurrentMessageItems = useSetAtom(currentMessageItemsAtom);
    const removePopupMessagesByType = useSetAtom(removePopupMessagesByTypeAtom);
    const didAutoPopulateRef = useRef(false);

    useEffect(() => {
        setIsBeaverWindowOpen(true);
        return () => setIsBeaverWindowOpen(false);
    }, [setIsBeaverWindowOpen]);

    useEffect(() => {
        if (didAutoPopulateRef.current) return;
        if (!isProfileLoaded) return;
        didAutoPopulateRef.current = true;

        // The sidebar owns the staged message context while it is open — both
        // surfaces write the same atoms, so re-staging here would discard what
        // the user already attached there.
        if (store.get(isSidebarVisibleAtom)) return;
        if (!getPref('addSelectedItemsOnOpen')) return;
        // Reader context is handled by useReaderTabSelection, which starts
        // tracking as soon as this window marks Beaver as visible.
        if (!store.get(isLibraryTabAtom)) return;

        logger('useBeaverWindowContext: staging Zotero selection for the separate window');
        setCurrentMessageItems([]);
        removePopupMessagesByType(['items_summary']);
        updateMessageItemsFromZoteroSelection(getPref('maxAddAttachmentToMessage'));
    }, [
        isProfileLoaded,
        setCurrentMessageItems,
        removePopupMessagesByType,
        updateMessageItemsFromZoteroSelection,
    ]);
}
