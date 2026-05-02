import React, { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { firstRunReturnRequestedAtom } from '../../../atoms/firstRun';
import { newThreadAtom } from '../../../atoms/threads';
import { currentMessageContentAtom } from '../../../atoms/messageComposition';
import { sendWSMessageAtom } from '../../../atoms/agentRunAtoms';
import { PromptOrigin } from '../../../agents/types';
import {
    FIRST_RUN_FOLLOWUPS,
    FirstRunFollowup,
    renderFollowup,
} from '../../../types/firstRunFollowups';
import Button from '../../ui/Button';
import { PlusSignIcon, ArrowRightIcon, ArrowLeftIcon, IdeaIcon, Icon } from '../../icons/icons';
import IconButton from '../../ui/IconButton';


interface NextStepsPanelProps {
    origin: Extract<PromptOrigin, { kind: 'first_run_card' }>;
    onDismiss: () => void;
}

/**
 * Rendered once below the first agent run that originated from a
 * first-run suggestion card (matched by run id). Three paths:
 *   1. Kind-specific follow-up prompts — submit a second run in the same
 *      thread with origin `first_run_followup`.
 *   2. "Back to suggestions" — re-renders the FirstRunPage from
 *      the persisted `profile.library_suggestions` (no regeneration,
 *      no second `complete` call).
 *   3. The tip line below documents the new-chat shortcut + icon.
 *
 * Auto-dismisses when:
 *   - any button is clicked
 *   - the user types in the input (follow-up path)
 *   - parent stops rendering it (origin run id changes / new run starts)
 */
const NextStepsPanel: React.FC<NextStepsPanelProps> = ({ origin, onDismiss }) => {
    const setReturnRequested = useSetAtom(firstRunReturnRequestedAtom);
    const newThread = useSetAtom(newThreadAtom);
    const sendWSMessage = useSetAtom(sendWSMessageAtom);
    const messageContent = useAtomValue(currentMessageContentAtom);

    const followups = FIRST_RUN_FOLLOWUPS[origin.card_kind] ?? [];

    // Auto-dismiss when the user types a follow-up. Capture the initial value
    // so we don't dismiss on the first render if the input is already non-empty
    // (rare but possible if state leaks across re-mounts).
    const initialContentRef = useRef<string>(messageContent);
    useEffect(() => {
        if (messageContent && messageContent !== initialContentRef.current) {
            onDismiss();
        }
    }, [messageContent, onDismiss]);

    const newChatShortcut = Zotero.isMac ? '⌘N' : 'Ctrl+N';

    const handleTryAnother = () => {
        setReturnRequested(true);
        onDismiss();
    };

    const handleNewChat = async () => {
        await newThread();
        onDismiss();
    };

    const handleFollowup = async (fu: FirstRunFollowup) => {
        const { prompt } = renderFollowup(
            fu,
            origin.topic_label,
            origin.collection_name,
        );
        onDismiss();
        await sendWSMessage(prompt, undefined, undefined, {
            kind: 'first_run_followup',
            card_kind: origin.card_kind,
            followup_id: fu.id,
            topic_label: origin.topic_label ?? null,
            collection_name: origin.collection_name ?? null,
        });
    };

    return (
        <div className="px-4">
            <div className="display-flex flex-col gap-2 pt-3">
                <div className="display-flex flex-row items-center justify-between gap-2">
                    <div
                        className="font-color-primary text-sm font-semibold uppercase"
                        style={{ letterSpacing: '0.05em' }}
                    >
                        Next steps
                    </div>
                </div>

                <div className="display-flex flex-col gap-15 items-start">
                    {followups.map((fu) => {
                        const { title } = renderFollowup(
                            fu,
                            origin.topic_label,
                            origin.collection_name,
                        );
                        return (
                            <Button
                                key={fu.id}
                                variant="ghost"
                                rightIcon={ArrowRightIcon}
                                className="text-left"
                                iconClassName="-ml-1"
                                style={{fontSize: '1rem'}}
                                onClick={() => void handleFollowup(fu)}
                            >
                                {title}
                            </Button>
                        );
                    })}
                    <div className="display-flex flex-col gap-1 items-start">
                        <Button
                            variant="ghost"
                            icon={ArrowLeftIcon}
                            className="mt-3 -mr-1"
                            iconClassName="-mr-1"
                            style={{fontSize: '1rem', paddingLeft: '0px'}}
                            onClick={handleTryAnother}
                        >
                            Back to suggestions
                        </Button>
                        <div
                            className="display-flex flex-row items-center gap-1 ml-1 text-start font-color-secondary"
                            style={{fontSize: '0.875rem'}}
                        >
                            <Icon icon={IdeaIcon} size={10}/>
                            <span>
                                Start a new chat anytime with
                            </span>
                            <Icon icon={PlusSignIcon} size={10}/>
                            <span>
                                (top left) or with
                            </span>
                            <span
                                style={{
                                    background: 'var(--fill-quinary)',
                                    padding: '1px 3px',
                                    borderRadius: '3px',
                                    fontSize: '0.8em',
                                }}
                            >
                                {newChatShortcut}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default NextStepsPanel;
