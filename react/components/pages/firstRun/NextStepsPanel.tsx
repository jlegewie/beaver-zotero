import React, { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { firstRunReturnRequestedAtom } from '../../../atoms/firstRun';
import { newThreadAtom } from '../../../atoms/threads';
import { currentMessageContentAtom } from '../../../atoms/messageComposition';
import { sendWSMessageAtom } from '../../../atoms/agentRunAtoms';
import { PromptOrigin } from '../../../agents/types';
import { CardKind } from '../../../types/librarySuggestions';
import {
    FirstRunFollowup,
    getFollowupsForCardKind,
    getFollowupsForWhereToStart,
    getWhereToStartCardKind,
    renderFollowup,
} from '../../../types/firstRunFollowups';
import Button from '../../ui/Button';
import { ArrowRightIcon, Icon, CancelIcon } from '../../icons/icons';
import BackToSuggestions from './BackToSuggestions';
import IconButton from '../../ui/IconButton';
import Tooltip from '../../ui/Tooltip';
import { textWithTrailingNoWrap } from '../../../utils/textWithTrailingNoWrap';


/**
 * Origins that surface guided next steps: a first-run suggestion card or a
 * "Where should we start?" launcher action. Both carry the context the
 * follow-up templates and the `first_run_followup` run need.
 */
type NextStepsOrigin =
    | Extract<PromptOrigin, { kind: 'first_run_card' }>
    | Extract<PromptOrigin, { kind: 'where_to_start' }>;

interface NextStepsPanelProps {
    origin: NextStepsOrigin;
    onDismiss: () => void;
}

/**
 * Rendered once below the first agent run that originated from a first-run
 * suggestion card or the "Where should we start?" launcher (matched by run id).
 * Three paths:
 *   1. Follow-up prompts — submit a second run in the same thread with origin
 *      `first_run_followup`. The follow-up list is resolved by launcher action
 *      id (where_to_start) or by card kind (suggestion card).
 *   2. "Back to suggestions" — re-renders the originating onboarding page
 *      (FirstRunPage or WhereToStartPage, per the user's sticky variant).
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

    // Normalize the two origin shapes into the fields the follow-up flow needs.
    const isWhereToStart = origin.kind === 'where_to_start';
    const topicLabel = origin.topic_label ?? null;
    const collectionName = isWhereToStart ? null : (origin.collection_name ?? null);
    const emptyLibrary = isWhereToStart ? false : (origin.empty_library ?? false);
    // The `first_run_followup` run carries a card kind for analytics. Launcher
    // runs derive a representative one from the action; suggestion cards use
    // their own kind directly.
    const followupCardKind: CardKind = isWhereToStart
        ? getWhereToStartCardKind(origin.action_id)
        : origin.card_kind;

    const followups = isWhereToStart
        ? getFollowupsForWhereToStart(origin.action_id)
        : getFollowupsForCardKind(origin.card_kind, emptyLibrary);

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
        const { prompt } = renderFollowup(fu, topicLabel, collectionName);
        onDismiss();
        await sendWSMessage(prompt, {
            origin: {
                kind: 'first_run_followup',
                card_kind: followupCardKind,
                followup_id: fu.id,
                topic_label: topicLabel,
                collection_name: collectionName,
                empty_library: emptyLibrary,
            },
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
                        const { title } = renderFollowup(fu, topicLabel, collectionName);
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
                    <BackToSuggestions
                        onDismiss={onDismiss}
                        backTarget={isWhereToStart ? 'launcher' : 'suggestions'}
                    />
                </div>
            </div>
        </div>
    );
};

export default NextStepsPanel;
