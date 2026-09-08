import React, { useCallback, useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { activeRunAtom, currentThreadNameAtom } from '@beaver/agent-core/run-state/atoms';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { ArrowUpRightIcon, CancelIcon } from '../icons/icons';
import { isWSChatPendingAtom } from '../../atoms/agentRunAtoms';
import {
    closeQuickPromptAtom,
    hasActiveWorkAtom,
    quickPromptStateAtom,
    toggleQuickPromptAtom,
} from '../../atoms/quickPrompt';
import { isSidebarVisibleAtom, selectedZoteroTabIdAtom } from '../../atoms/ui';
import { eventManager } from '../../events/eventManager';
import { useEventSubscription } from '../../hooks/useEventSubscription';
import { uiManager } from '../../ui/UIManager';
import InputArea from '../input/InputArea';
import PopupOverlayContainer from '../PopupOverlayContainer';
import RunPulse from '../runStatusPopup/RunPulse';
import { threadDisplayName } from '../runStatusPopup/runStatusPopupModel';

/** The compact control sizing shared with the run status popup's footer. */
const FOOTER_BUTTON_STYLE: React.CSSProperties = { padding: '2px 10px', fontSize: '0.875rem', whiteSpace: 'nowrap' };

function openBeaver(): void {
    eventManager.dispatch('toggleChat', { forceOpen: true });
}

/**
 * The close control, in the card's top-right corner. Shown only while the
 * pointer is over the card (see the stylesheet), so the card stays quiet;
 * Escape does the same and the tooltip says so.
 */
const CloseButton: React.FC<{ onClose: () => void }> = ({ onClose }) => (
    <div className="beaver-quick-prompt__dismiss">
        <Tooltip content="Close" secondaryContent="Esc" showArrow singleLine>
            <IconButton icon={CancelIcon} variant="ghost-secondary" onClick={onClose} ariaLabel="Close" />
        </Tooltip>
    </div>
);

/**
 * Shown instead of the composer while the open thread's run is live: one chat
 * runs at a time, so a message typed now would either join that chat or have
 * to stop it. The run status popup below reports the run itself.
 */
const BusyNotice: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const threadName = useAtomValue(currentThreadNameAtom);
    const activeRun = useAtomValue(activeRunAtom);
    const name = threadDisplayName(threadName, activeRun);
    return (
        <div className="beaver-quick-prompt__card beaver-quick-prompt__card--busy">
            <CloseButton onClose={onClose} />
            <div className="beaver-quick-prompt__notice">
                <div className="beaver-quick-prompt__notice-mark"><RunPulse /></div>
                <div className="beaver-quick-prompt__notice-text">
                    <div className="font-color-primary beaver-quick-prompt__notice-title">Beaver is still working</div>
                    <div className="font-color-secondary beaver-quick-prompt__notice-detail" title={name}>
                        Wait for “{name}” to finish, or open Beaver to start another chat.
                    </div>
                </div>
            </div>
            <div className="beaver-quick-prompt__footer">
                <div className="flex-1" />
                <Button variant="outline" style={FOOTER_BUTTON_STYLE} rightIcon={ArrowUpRightIcon} onClick={openBeaver}>
                    Open Beaver
                </Button>
            </div>
        </div>
    );
};

/**
 * A composer in the corner of the main window while the sidebar is closed,
 * opened by its keyboard shortcut. It sends into a fresh thread the way the
 * sidebar's composer would, so the run it starts is picked up by the run
 * status popup in the same corner; the popup closes as soon as the run
 * starts. Escape closes it and keeps the draft.
 *
 * Always mounted: the shortcut's event needs a subscriber whether or not the
 * popup is showing.
 */
const QuickPromptPopup: React.FC = () => {
    const state = useAtomValue(quickPromptStateAtom);
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const hasActiveWork = useAtomValue(hasActiveWorkAtom);
    const selectedTabId = useAtomValue(selectedZoteroTabIdAtom);
    const toggle = useSetAtom(toggleQuickPromptAtom);
    const close = useSetAtom(closeQuickPromptAtom);
    const rootRef = useRef<HTMLDivElement>(null);
    // The tab the popup was opened in. Its attachments — the open file, a
    // selection, selected items — belong to that tab, so it does not outlive it.
    const openedInTabRef = useRef<{ tabId: string | null } | null>(null);
    const inputRef = useRef<HTMLElement | null>(null);
    // Where focus was when the shortcut fired (the items tree, a reader), to
    // return there when the popup goes away.
    const restoreFocusRef = useRef<HTMLElement | null>(null);

    const dismiss = useCallback(() => {
        close();
        const target = restoreFocusRef.current;
        restoreFocusRef.current = null;
        if (target && target.isConnected) {
            target.focus();
        } else {
            uiManager.focusToggleButton();
        }
    }, [close]);

    useEventSubscription('toggleQuickPrompt', () => {
        const doc = Zotero.getMainWindow()?.document;
        const active = doc?.activeElement as HTMLElement | null;
        // The document itself is not a place to send focus back to.
        const focused = active && active !== doc?.body && active !== doc?.documentElement ? active : null;
        void toggle().then((outcome) => {
            switch (outcome) {
                case 'focus-sidebar':
                    eventManager.dispatch('focusInput', {});
                    break;
                case 'open-sidebar':
                    openBeaver();
                    break;
                case 'closed':
                    dismiss();
                    break;
                case 'opened':
                    restoreFocusRef.current = focused;
                    break;
            }
        });
    }, [toggle, dismiss]);

    // The popup steps aside on its own: when the sidebar opens (it now shows
    // the same draft and thread), when the message it composed has been sent
    // (the run status popup takes over), and when the run it was waiting on
    // has finished (that popup reports the outcome; the shortcut reopens a
    // composer).
    useEffect(() => {
        if (!state) return;
        if (isSidebarVisible) {
            close();
        } else if (state.mode === 'compose' && isPending) {
            dismiss();
        } else if (state.mode === 'busy' && !hasActiveWork) {
            dismiss();
        }
    }, [state, isSidebarVisible, isPending, hasActiveWork, close, dismiss]);

    // Switching tabs closes the popup without touching focus: Zotero has just
    // moved it into the new tab, and the draft is kept for the next open.
    useEffect(() => {
        if (!state) {
            openedInTabRef.current = null;
            return;
        }
        if (!openedInTabRef.current) {
            openedInTabRef.current = { tabId: selectedTabId };
            return;
        }
        if (openedInTabRef.current.tabId !== selectedTabId) close();
    }, [state, selectedTabId, close]);

    const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape' || event.defaultPrevented || isImeKeyEvent(event.nativeEvent)) return;
        // A menu the composer opened (actions, sources, model) owns Escape
        // while it is up; menus are portalled to the floating root, so they
        // are looked for there.
        const host = rootRef.current?.closest('#beaver-pane-floating-popup') ?? rootRef.current;
        if (host?.querySelector('[role="menu"], [role="listbox"]')) return;
        event.preventDefault();
        dismiss();
    }, [dismiss]);

    if (!state || isSidebarVisible) return null;

    return (
        <div
            ref={rootRef}
            className="beaver-quick-prompt"
            role="dialog"
            aria-label={state.mode === 'busy' ? 'Beaver is still working' : 'New chat with Beaver'}
            onKeyDown={handleKeyDown}
        >
            {state.mode === 'busy' ? (
                <BusyNotice onClose={dismiss} />
            ) : (
                <div className="beaver-quick-prompt__card">
                    <CloseButton onClose={dismiss} />
                    <div className="beaver-quick-prompt__composer">
                        <PopupOverlayContainer />
                        <InputArea inputRef={inputRef} verticalPosition="above" placeholder="Ask Beaver — @ to add a source, / for actions" />
                    </div>
                </div>
            )}
        </div>
    );
};

export default QuickPromptPopup;
