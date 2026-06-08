import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { getPref, setPref } from '../../src/utils/prefs';
import { isSidebarVisibleAtom, isLibraryTabAtom } from '../atoms/ui';
import { addFloatingPopupMessageAtom, floatingPopupMessagesAtom } from '../atoms/floatingPopup';
import { currentNoteItemAtom } from '../atoms/zoteroContext';
import { getCurrentReader } from '../utils/readerUtils';
import { logger } from '../../src/utils/logger';

const WELCOME_POPUP_ID = 'onboarding-welcome';
const READER_TIP_POPUP_ID = 'onboarding-reader-tip';
const NOTE_TIP_POPUP_ID = 'onboarding-note-tip';
const ONE_HOUR_MS = 60 * 60 * 1000;
const READER_TIP_DELAY_MS = 500;
const NOTE_TIP_DELAY_MS = 500;

/**
 * Manages onboarding popups for first-time user engagement:
 * 1. Welcome popup on first install (not shown to upgrading users)
 * 2. Reader tip popup on first PDF reader open (shown to all users once; re-shown
 *    once after the tip was revised, and suppressed while a version-update popup is up)
 * 3. Note tip popup on first note tab open (shown to all users once)
 */
export function useOnboardingPopups() {
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);
    const noteItem = useAtomValue(currentNoteItemAtom);
    const floatingPopupMessages = useAtomValue(floatingPopupMessagesAtom);
    const addFloatingPopupMessage = useSetAtom(addFloatingPopupMessageAtom);
    const welcomeShownThisSessionRef = useRef(false);
    const readerTipShownThisSessionRef = useRef(false);
    const noteTipShownThisSessionRef = useRef(false);

    // === Popup 1: Welcome popup on first install ===
    useEffect(() => {
        if (welcomeShownThisSessionRef.current) return;

        const alreadyShown = getPref('onboardingWelcomeShown');
        if (alreadyShown) return;

        // Don't show if sidebar is already open
        if (isSidebarVisible) return;

        welcomeShownThisSessionRef.current = true;
        setPref('onboardingWelcomeShown', true);
        setPref('onboardingWelcomeShownAt', new Date().toISOString());
        logger('useOnboardingPopups: Showing welcome onboarding popup');

        addFloatingPopupMessage({
            id: WELCOME_POPUP_ID,
            type: 'welcome_onboarding',
            expire: false,
            cancelable: false,
        });
    }, [isSidebarVisible, addFloatingPopupMessage]);

    // === Popup 2: Reader tip on first PDF reader tab ===
    useEffect(() => {
        if (readerTipShownThisSessionRef.current) return;

        // Only trigger when user is on a reader tab (not library)
        if (isLibraryTab) return;

        // Versioned pref: the reader tip was substantially revised, so re-show it
        // once to existing users who only saw the previous version.
        const alreadyShown = getPref('onboardingReaderTipShownV2');
        if (alreadyShown) return;

        // Don't show if Beaver sidebar is already open
        if (isSidebarVisible) return;

        // Don't compete with the version-update popup: skip while one is showing, and
        // enforce a gap after it was last shown so the tip doesn't appear right after it.
        if (floatingPopupMessages.some((msg) => msg.type === 'version_update')) {
            logger('useOnboardingPopups: Skipping reader tip (version update popup is showing)');
            return;
        }
        const versionPopupShownAt = getPref('versionUpdatePopupShownAt');
        if (versionPopupShownAt) {
            const elapsed = Date.now() - new Date(versionPopupShownAt).getTime();
            if (elapsed < ONE_HOUR_MS) {
                logger('useOnboardingPopups: Skipping reader tip (within 1-hour gap from version update popup)');
                return;
            }
        }

        // Verify it's a PDF (not EPUB, HTML snapshot, etc.)
        const reader = getCurrentReader(Zotero.getMainWindow());
        if (!reader) return;
        try {
            const item = Zotero.Items.get(reader.itemID);
            if (!item || !item.isPDFAttachment()) return;
        } catch {
            return;
        }

        // Enforce 1-hour gap from welcome popup
        const welcomeShownAt = getPref('onboardingWelcomeShownAt');
        if (welcomeShownAt) {
            const elapsed = Date.now() - new Date(welcomeShownAt).getTime();
            if (elapsed < ONE_HOUR_MS) {
                logger('useOnboardingPopups: Skipping reader tip (within 1-hour gap from welcome popup)');
                return;
            }
        }

        // Only mark the tip as shown once it is actually displayed
        const timerId = setTimeout(() => {
            readerTipShownThisSessionRef.current = true;
            setPref('onboardingReaderTipShownV2', true);
            logger('useOnboardingPopups: Showing reader tip popup');
            addFloatingPopupMessage({
                id: READER_TIP_POPUP_ID,
                type: 'reader_tip',
                expire: false,
                cancelable: false,
            });
        }, READER_TIP_DELAY_MS);

        return () => clearTimeout(timerId);
    }, [isLibraryTab, isSidebarVisible, floatingPopupMessages, addFloatingPopupMessage]);

    // === Popup 3: Note tip on first note tab ===
    useEffect(() => {
        if (noteTipShownThisSessionRef.current) return;

        // Only trigger when a note is open in a tab
        if (!noteItem) return;

        const alreadyShown = getPref('onboardingNoteTipShown');
        if (alreadyShown) return;

        // Don't show if Beaver sidebar is already open
        if (isSidebarVisible) return;

        // Enforce 1-hour gap from welcome popup
        const welcomeShownAt = getPref('onboardingWelcomeShownAt');
        if (welcomeShownAt) {
            const elapsed = Date.now() - new Date(welcomeShownAt).getTime();
            if (elapsed < ONE_HOUR_MS) {
                logger('useOnboardingPopups: Skipping note tip (within 1-hour gap from welcome popup)');
                return;
            }
        }

        noteTipShownThisSessionRef.current = true;
        setPref('onboardingNoteTipShown', true);
        logger('useOnboardingPopups: Showing note tip popup (after delay)');

        const timerId = setTimeout(() => {
            addFloatingPopupMessage({
                id: NOTE_TIP_POPUP_ID,
                type: 'note_tip',
                expire: false,
                cancelable: false,
            });
        }, NOTE_TIP_DELAY_MS);

        return () => clearTimeout(timerId);
    }, [noteItem, isSidebarVisible, addFloatingPopupMessage]);
}
