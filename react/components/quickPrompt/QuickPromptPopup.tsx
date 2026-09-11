import { useSurfaceWindow } from '../../runtime/SurfaceWindowContext';
import React, { useCallback, useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { activeRunAtom, currentThreadNameAtom } from '@beaver/agent-core/run-state/atoms';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { AlertIcon, ArrowRightIcon, CancelIcon, Icon, Spinner } from '../icons/icons';
import { isWSChatPendingAtom } from '../../atoms/agentRunAtoms';
import { chatAccessGateAtom, type ChatAccessGate } from '../../atoms/chatAccess';
import {
    closeQuickPromptAtom,
    hasActiveWorkAtom,
    openQuickPromptAtom,
    quickPromptStateAtom,
    toggleQuickPromptAtom,
} from '../../atoms/quickPrompt';
import { runStatusPopupEnabledAtom } from '../../atoms/runStatusPopup';
import { threadNavigationSeqAtom } from '../../atoms/threads';
import { useRunFocusHandoff } from './useRunFocusHandoff';
import { isSidebarVisibleAtom, selectedZoteroTabIdAtom } from '../../atoms/ui';
import { eventManager } from '../../events/eventManager';
import { useEventSubscription } from '../../hooks/useEventSubscription';
import { uiManager } from '../../ui/UIManager';
import InputArea from '../input/InputArea';
import DragDropWrapper from '../input/DragDropWrapper';
import PopupOverlayContainer from '../PopupOverlayContainer';
import RunPulse from '../runStatusPopup/RunPulse';
import { threadDisplayName } from '../runStatusPopup/runStatusPopupModel';

/** The compact control sizing shared with the run status popup's footer. */
const FOOTER_BUTTON_STYLE: React.CSSProperties = { padding: '2px 10px', fontSize: '0.875rem', whiteSpace: 'nowrap' };

function openBeaver(): void {
    eventManager.dispatch('toggleChat', { forceOpen: true });
}

/**
 * The sidebar's React roots. Closing the sidebar only collapses its pane, so
 * an element inside one stays connected while being invisible — focus must not
 * be handed back to it when the popup goes away.
 */
const SIDEBAR_ROOTS = '#beaver-react-root-library, #beaver-react-root-reader';

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

/** A card that says why the composer is not here, with the way to Beaver. */
const NoticeCard: React.FC<{
    mark: React.ReactNode;
    title: string;
    detail: string;
    onClose: () => void;
}> = ({ mark, title, detail, onClose }) => (
    <div className="beaver-quick-prompt__card beaver-quick-prompt__card--busy">
        <CloseButton onClose={onClose} />
        <div className="beaver-quick-prompt__notice">
            <div className="beaver-quick-prompt__notice-mark">{mark}</div>
            <div className="beaver-quick-prompt__notice-text">
                <div className="font-color-primary beaver-quick-prompt__notice-title">{title}</div>
                <div className="font-color-secondary beaver-quick-prompt__notice-detail" title={detail}>
                    {detail}
                </div>
            </div>
        </div>
        <div className="beaver-quick-prompt__footer">
            <div className="flex-1" />
            <Button variant="outline" style={FOOTER_BUTTON_STYLE} rightIcon={ArrowRightIcon} onClick={openBeaver}>
                Open Beaver
            </Button>
        </div>
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
        <NoticeCard
            mark={<RunPulse />}
            title="Beaver is still working"
            detail={`Wait for “${name}” to finish, or open Beaver to start another chat.`}
            onClose={onClose}
        />
    );
};

/**
 * What each account state says. Beaver itself shows the screen that resolves
 * the state, so every notice points there; the loading ones need no action
 * and the popup moves on to the composer by itself once Beaver is ready.
 */
const BLOCKED_COPY: Record<ChatAccessGate, { title: string; detail: string }> = {
    loading: {
        title: 'Beaver is still loading',
        detail: 'The chat opens here on its own as soon as Beaver is ready.',
    },
    connecting: {
        title: 'Beaver is still loading',
        detail: 'The chat opens here on its own as soon as Beaver is ready.',
    },
    'signed-out': {
        title: 'Sign in to use Beaver',
        detail: 'Open Beaver to sign in, then press the shortcut again.',
    },
    'update-required': {
        title: 'Update Beaver to continue',
        detail: 'This version of Beaver is no longer supported. Open Beaver to see how to update.',
    },
    'downgrade-ack': {
        title: 'Your plan has changed',
        detail: 'Open Beaver to review what changed before starting a chat.',
    },
    'upgrade-consent': {
        title: 'Review your new plan',
        detail: 'Your account moved to a plan that syncs data with Beaver. Open Beaver to review and agree before starting a chat.',
    },
    onboarding: {
        title: 'Finish setting up Beaver',
        detail: 'Open Beaver to complete setup before starting a chat.',
    },
};

const LOADING_GATES: ReadonlySet<ChatAccessGate> = new Set(['loading', 'connecting']);

/** Shown instead of the composer while the account cannot start a chat. */
const BlockedNotice: React.FC<{ reason: ChatAccessGate; onClose: () => void }> = ({ reason, onClose }) => {
    const copy = BLOCKED_COPY[reason];
    return (
        <NoticeCard
            mark={LOADING_GATES.has(reason) ? <Spinner size={16} /> : <Icon icon={AlertIcon} size={16} className="font-color-secondary" />}
            title={copy.title}
            detail={copy.detail}
            onClose={onClose}
        />
    );
};

/**
 * A composer in the corner of the main window while the sidebar is closed,
 * opened by its keyboard shortcut — pressed with the sidebar open, the
 * shortcut closes it and the popup takes its place. It sends into a fresh
 * thread the way the sidebar's composer would, so the run it starts is picked
 * up by the run status popup in the same corner; the popup closes as soon as
 * the run starts. Escape closes it and keeps the draft.
 *
 * Always mounted: the shortcut's event needs a subscriber whether or not the
 * popup is showing.
 */
const QuickPromptPopup: React.FC = () => {
    const surfaceWindow = useSurfaceWindow();
    const state = useAtomValue(quickPromptStateAtom);
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const hasActiveWork = useAtomValue(hasActiveWorkAtom);
    const chatAccessGate = useAtomValue(chatAccessGateAtom);
    const selectedTabId = useAtomValue(selectedZoteroTabIdAtom);
    const toggle = useSetAtom(toggleQuickPromptAtom);
    const open = useSetAtom(openQuickPromptAtom);
    const close = useSetAtom(closeQuickPromptAtom);
    const runPopupEnabled = useAtomValue(runStatusPopupEnabledAtom);
    const navigationSeq = useAtomValue(threadNavigationSeqAtom);
    const activeRun = useAtomValue(activeRunAtom);
    const requestRunFocus = useRunFocusHandoff({
        navigationKey: `${navigationSeq}:${selectedTabId}`,
        enabled: runPopupEnabled,
        sidebarVisible: isSidebarVisible,
        isPending,
        runId: activeRun?.id ?? null,
    });
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
        const doc = surfaceWindow.document;
        const runCard = !isSidebarVisible && hasActiveWork
            ? doc.querySelector<HTMLElement>('#beaver-pane-floating-popup .beaver-run-status-popup__card')
            : null;
        if (runCard) {
            close();
            (runCard.querySelector<HTMLElement>('[data-run-status-approve]:not(:disabled)') ?? runCard).focus();
            return;
        }
        const active = doc.activeElement as HTMLElement | null;
        // The document itself is not a place to send focus back to.
        const focused = active && active !== doc.body && active !== doc.documentElement ? active : null;
        void toggle().then((outcome) => {
            switch (outcome) {
                case 'replace-sidebar':
                    // The shortcut swaps the sidebar for the popup: the
                    // sidebar closes and the composer reopens in the corner.
                    restoreFocusRef.current = focused?.closest(SIDEBAR_ROOTS) ? null : focused;
                    eventManager.dispatch('toggleChat', {});
                    void open();
                    break;
                case 'closed':
                    dismiss();
                    break;
                case 'opened':
                    restoreFocusRef.current = focused;
                    break;
            }
        });
    }, [toggle, dismiss, open, isSidebarVisible, hasActiveWork, close, surfaceWindow]);

    // The popup steps aside on its own: when the sidebar opens (it now shows
    // the same draft and thread), when the message it composed has been sent
    // (the run status popup takes over), and when the run it was waiting on
    // has finished (that popup reports the outcome; the shortcut reopens a
    // composer). A notice about the account moves on to what the user asked
    // for, the composer, once the account can chat — Beaver finished loading,
    // or the screen the notice pointed to has been completed.
    useEffect(() => {
        if (!state) return;
        if (isSidebarVisible) {
            close();
        } else if (state.mode === 'compose' && isPending) {
            // Keep keyboard control with the run this composer started.
            // Restoring focus to the toolbar makes Enter reopen Beaver.
            const root = rootRef.current;
            const ownsFocus = root?.ownerDocument.hasFocus() && root.contains(root.ownerDocument.activeElement);
            if (!runPopupEnabled) {
                if (ownsFocus) dismiss();
                else close();
                return;
            }
            const host = root?.closest<HTMLElement>('#beaver-pane-floating-popup');
            if (ownsFocus && host) requestRunFocus(host, dismiss);
            close();
        } else if (state.mode === 'busy' && !hasActiveWork) {
            dismiss();
        } else if (state.mode === 'blocked' && chatAccessGate === null) {
            void open();
        }
    }, [state, isSidebarVisible, isPending, hasActiveWork, chatAccessGate, close, dismiss, open, requestRunFocus, runPopupEnabled]);

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
            aria-label={state.mode === 'compose' ? 'New chat with Beaver' : state.mode === 'busy' ? 'Beaver is still working' : BLOCKED_COPY[state.reason].title}
            onKeyDown={handleKeyDown}
        >
            {state.mode === 'busy' ? (
                <BusyNotice onClose={dismiss} />
            ) : state.mode === 'blocked' ? (
                <BlockedNotice reason={state.reason} onClose={dismiss} />
            ) : (
                <div className="beaver-quick-prompt__card">
                    <CloseButton onClose={dismiss} />
                    <DragDropWrapper overlayBorderRadius={12}>
                        <div className="beaver-quick-prompt__composer">
                            <PopupOverlayContainer />
                            <InputArea inputRef={inputRef} verticalPosition="above" placeholder="Ask Beaver" />
                        </div>
                    </DragDropWrapper>
                </div>
            )}
        </div>
    );
};

export default QuickPromptPopup;
