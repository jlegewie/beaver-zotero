import React, { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { currentMessageContentAtom } from '../../../atoms/messageComposition';
import { sendWSMessageAtom } from '../../../atoms/agentRunAtoms';
import { PromptOrigin } from '@beaver/agent-core/agents/types';
import {
    FirstRunFollowup,
    getFollowupsForWhereToStart,
    getWhereToStartCardKind,
    renderFollowup,
} from '../../../types/firstRunFollowups';
import Button from '@beaver/agent-ui/primitives/Button';
import { ArrowRightIcon, Icon, CancelIcon } from '../../icons/icons';
import BackToSuggestions from './BackToSuggestions';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { textWithTrailingNoWrap } from '../../../utils/textWithTrailingNoWrap';


/**
 * The origin that surfaces guided next steps: a "Where should we start?"
 * launcher action. It carries the context the follow-up templates and the
 * `first_run_followup` run need.
 */
type NextStepsOrigin = Extract<PromptOrigin, { kind: 'where_to_start' }>;

interface NextStepsPanelProps {
    origin: NextStepsOrigin;
    onDismiss: () => void;
}

/**
 * Rendered once below the first agent run that originated from the "Where
 * should we start?" launcher (matched by run id). Three paths:
 *   1. Follow-up prompts — submit a second run in the same thread with origin
 *      `first_run_followup`, resolved by the launcher action id.
 *   2. "Back to starting points" — reopens the launcher.
 *   3. The tip line below documents the new-chat shortcut + icon.
 *
 * Auto-dismisses when:
 *   - any button is clicked
 *   - the user types in the input (follow-up path)
 *   - parent stops rendering it (origin run id changes / new run starts)
 */
const NextStepsPanel: React.FC<NextStepsPanelProps> = ({ origin, onDismiss }) => {
    const sendWSMessage = useSetAtom(sendWSMessageAtom);
    const messageContent = useAtomValue(currentMessageContentAtom);

    const topicLabel = origin.topic_label ?? null;
    // The `first_run_followup` run carries a card kind for analytics, derived
    // from the launcher action.
    const followupCardKind = getWhereToStartCardKind(origin.action_id);
    const followups = getFollowupsForWhereToStart(origin.action_id);

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
        const { prompt } = renderFollowup(fu, topicLabel);
        onDismiss();
        await sendWSMessage(prompt, {
            origin: {
                kind: 'first_run_followup',
                card_kind: followupCardKind,
                followup_id: fu.id,
                topic_label: topicLabel,
                collection_name: null,
                empty_library: false,
            },
        });
    };

    return (
        <div className="composer-docked-bar next-steps-panel px-4 py-3">
            <div className="display-flex flex-col gap-15">
                <div className="display-flex flex-row items-center justify-between gap-2">
                    <div
                        className="font-color-primary text-sm font-semibold uppercase"
                        style={{ letterSpacing: '0.05em' }}
                    >
                        Guided next steps
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
                        const { title } = renderFollowup(fu, topicLabel);
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
