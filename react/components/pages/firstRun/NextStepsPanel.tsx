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
import { ArrowRightIcon, Icon, CancelIcon } from '../../icons/icons';
import BackToSuggestions from './BackToSuggestions';
import IconButton from '../../ui/IconButton';
import Tooltip from '../../ui/Tooltip';
import { textWithTrailingNoWrap } from '../../../utils/textWithTrailingNoWrap';


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
        <div className="next-steps-panel px-4 py-3">
            <div className="display-flex flex-col gap-15">
                <div className="display-flex flex-row items-center justify-between gap-2">
                    <div
                        className="font-color-primary text-sm font-semibold uppercase"
                        style={{ letterSpacing: '0.05em' }}
                    >
                        Next steps
                    </div>
                    <Tooltip content="Dismiss next steps" showArrow singleLine>
                        <IconButton
                            icon={CancelIcon}
                            onClick={onDismiss}
                            ariaLabel="Dismiss next steps"
                            variant="ghost-secondary"
                        />
                    </Tooltip>
                </div>
                

                <div className="display-flex flex-col gap-1 items-start">
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
                                className="text-left"
                                onClick={() => void handleFollowup(fu)}
                                style={{fontSize: '1rem', padding: '2px 0px'}}
                            >
                                <span>
                                    {textWithTrailingNoWrap(
                                        title,
                                        <Icon icon={ArrowRightIcon} className="ml-1" style={{ transform: 'translateY(0.2em)' }} />,
                                    )}
                                </span>
                            </Button>
                        );
                    })}
                </div>
                <div className="mt-3">
                    <BackToSuggestions onDismiss={onDismiss} />
                </div>
            </div>
        </div>
    );
};

export default NextStepsPanel;
