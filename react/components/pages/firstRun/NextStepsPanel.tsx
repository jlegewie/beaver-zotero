import React, { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    firstRunReturnRequestedAtom,
    firstRunOriginRunIdAtom,
} from '../../../atoms/firstRun';
import { newThreadAtom } from '../../../atoms/threads';
import { currentMessageContentAtom } from '../../../atoms/messageComposition';
import Button from '../../ui/Button';
import { CancelIcon } from '../../icons/icons';
import IconButton from '../../ui/IconButton';

interface NextStepsPanelProps {
    onDismiss: () => void;
}

/**
 * Rendered once below the first agent run that originated from a
 * first-run suggestion card (matched by run id). Two paths:
 *   1. "Try another starting point" — re-renders the FirstRunPage from
 *      the persisted `profile.library_suggestions` (no regeneration,
 *      no second `complete` call).
 *   2. "Start a new chat" — creates a fresh empty thread.
 *
 * Auto-dismisses when:
 *   - either button is clicked
 *   - the user types in the input (follow-up path)
 *   - parent stops rendering it (origin run id changes / new run starts)
 */
const NextStepsPanel: React.FC<NextStepsPanelProps> = ({ onDismiss }) => {
    const setReturnRequested = useSetAtom(firstRunReturnRequestedAtom);
    const setOriginRunId = useSetAtom(firstRunOriginRunIdAtom);
    const newThread = useSetAtom(newThreadAtom);
    const messageContent = useAtomValue(currentMessageContentAtom);

    // Auto-dismiss when the user types a follow-up. Capture the initial value
    // so we don't dismiss on the first render if the input is already non-empty
    // (rare but possible if state leaks across re-mounts).
    const initialContentRef = useRef<string>(messageContent);
    useEffect(() => {
        if (messageContent && messageContent !== initialContentRef.current) {
            onDismiss();
        }
    }, [messageContent, onDismiss]);

    const newChatShortcut = Zotero.isMac ? '⌘⇧N' : 'Ctrl+Shift+N';

    const handleTryAnother = () => {
        // Clear the origin marker so the just-finished run no longer shows
        // this panel even if the user navigates back to its thread.
        setOriginRunId(null);
        setReturnRequested(true);
        onDismiss();
    };

    const handleNewChat = async () => {
        setOriginRunId(null);
        await newThread();
        onDismiss();
    };

    return (
        <div className="px-4">
            <div className="display-flex flex-col gap-2 pt-3">
                <div className="display-flex flex-row items-center justify-between gap-2">
                    <div
                        className="font-color-tertiary text-xs font-semibold uppercase"
                        style={{ letterSpacing: '0.05em' }}
                    >
                        Next steps
                    </div>
                    <IconButton
                        icon={CancelIcon}
                        onClick={onDismiss}
                        ariaLabel="Dismiss next steps"
                        variant="ghost-secondary"
                        className="scale-80"
                    />
                </div>

                <div className="display-flex flex-col gap-1">
                    <Button
                        variant="surface-light"
                        className="truncate text-left w-full"
                        style={{ display: 'block' }}
                        onClick={handleTryAnother}
                    >
                        Try another starting point
                    </Button>
                    <Button
                        variant="surface-light"
                        className="truncate text-left w-full"
                        style={{ display: 'block' }}
                        onClick={() => void handleNewChat()}
                    >
                        Start a new chat
                    </Button>
                    <div className="font-color-tertiary text-xs pl-1">
                        Anytime with + or {newChatShortcut}
                    </div>
                </div>

                <div className="font-color-secondary text-sm pt-1">
                    Ask a follow-up below ↓
                </div>
            </div>
        </div>
    );
};

export default NextStepsPanel;
