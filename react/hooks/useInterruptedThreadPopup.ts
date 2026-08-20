/**
 * Offers to reopen the chat that was cut off when Beaver last shut down.
 *
 * The shutdown path records the thread in a preference
 * (`src/utils/interruptedThreadPrefs.ts`); this hook consumes that record once
 * and shows a floating popup whose button reopens the thread.
 */

import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { isAuthenticatedAtom, userIdAtom } from '../atoms/auth';
import { currentThreadIdAtom } from '../atoms/threads';
import { addFloatingPopupMessageAtom, floatingPopupMessagesAtom } from '../atoms/floatingPopup';
import { eventManager } from '../events/eventManager';
import { ArrowRightIcon } from '../components/icons/icons';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    clearInterruptedThread,
    getInterruptedThread,
} from '../../src/utils/interruptedThreadPrefs';

/** Shared with `useOnboardingPopups`, which stands down while this popup is up. */
export const INTERRUPTED_THREAD_POPUP_ID = 'interrupted-thread-resume';

export function useInterruptedThreadPopup() {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const userId = useAtomValue(userIdAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const floatingPopupMessages = useAtomValue(floatingPopupMessagesAtom);
    const addFloatingPopupMessage = useSetAtom(addFloatingPopupMessageAtom);
    const jotaiStore = useStore();
    const shownThisSessionRef = useRef(false);

    useEffect(() => {
        if (shownThisSessionRef.current) return;

        // Reopening a thread needs an account; auth is restored asynchronously
        // at start, so wait for it rather than dropping the record.
        if (!isAuthenticated || !userId) return;

        // Don't compete with the version-update popup, which is a multi-step
        // tour shown at exactly the same moment after an upgrade. The record
        // survives, so this runs again once that popup is dismissed.
        //
        // Read the list from the store rather than from the subscribed value:
        // the upgrade hook adds its popup from an effect in the same commit,
        // which the render-time snapshot would not show yet. Consuming the
        // record is irreversible, so this guard must see the newest list.
        if (jotaiStore.get(floatingPopupMessagesAtom).some((msg) => msg.type === 'version_update')) {
            logger('useInterruptedThreadPopup: Deferring (version update popup is showing)');
            return;
        }

        // Read as late as possible: clearing the record and adding the popup
        // happen together, so a second window cannot show it twice.
        const interrupted = getInterruptedThread();
        if (!interrupted) return;

        shownThisSessionRef.current = true;
        clearInterruptedThread();

        // Another account signed in since the interruption: that thread is not
        // theirs to reopen, and loading it would only fail against their token.
        if (interrupted.userId !== userId) {
            logger('useInterruptedThreadPopup: Discarding a record from another account');
            return;
        }

        // Nothing to go back to when that thread is already open.
        if (interrupted.threadId === currentThreadId) return;

        logger(`useInterruptedThreadPopup: Offering to reopen thread ${interrupted.threadId}`);

        addFloatingPopupMessage({
            id: INTERRUPTED_THREAD_POPUP_ID,
            type: 'info',
            title: 'Beaver chat was interrupted',
            text: interrupted.threadName
                ? `Beaver closed before it finished working on “${interrupted.threadName}”.`
                : 'Beaver closed before it finished working on your last chat.',
            expire: false,
            button: {
                text: 'Open chat',
                rightIcon: ArrowRightIcon,
                variant: 'solid',
                onClick: () => {
                    // The protocol handler opens Beaver, loads the thread, and
                    // waits for the session if auth has lapsed since.
                    eventManager.dispatch('loadThread', { threadId: interrupted.threadId });
                },
            },
        });
        // `floatingPopupMessages` is a dependency, not a read: it re-runs this
        // effect when the version-update popup is dismissed.
    }, [isAuthenticated, userId, currentThreadId, floatingPopupMessages, addFloatingPopupMessage, jotaiStore]);
}
