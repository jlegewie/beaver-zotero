import React, { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { PendingQuestion } from '@beaver/agent-core/run-state/pendingQuestions';
import type { AskUserQuestionAnswer } from '@beaver/agent-core/protocol/agentProtocol';
import {
    isRunReconnectingAtom,
    sendAskUserQuestionResponseAtom,
} from '../../atoms/agentRunAtoms';
import { useStopRun } from '../../hooks/useStopRun';
import AskUserQuestionCard from '@beaver/agent-ui/chat/AskUserQuestionCard';
import { RECONNECT_HELD_CAPTION } from '@beaver/agent-core/transport/connectionFailure';
import { useRunReconnectShown } from '../../hooks/useVisibleReconnect';

interface AskUserQuestionPanelProps {
    pendingQuestion: PendingQuestion;
}

/**
 * Composer takeover for a pending ask_user_question request.
 *
 * Rendered by Sidebar INSTEAD of InputArea while the agent blocks on the
 * user's answer, so the question sits where the user is already looking and
 * cannot be scrolled away. The user's draft message is untouched — this panel
 * never reads or writes currentMessageContentAtom, so the composer restores
 * the draft when it returns.
 *
 * The answers travel back over the run's WebSocket connection, correlated on
 * the question and toolcall ids the request arrived with. Stop cancels the run
 * outright by closing that connection, which is a different outcome from
 * skipping every question — a response with nothing answered still lets the
 * run continue.
 */
export const AskUserQuestionPanel: React.FC<AskUserQuestionPanelProps> = ({ pendingQuestion }) => {
    const sendResponse = useSetAtom(sendAskUserQuestionResponseAtom);
    const isReconnecting = useAtomValue(isRunReconnectingAtom);
    const reconnectShown = useRunReconnectShown();

    const handleSubmit = useCallback((answers: AskUserQuestionAnswer[]) => {
        sendResponse({
            questionId: pendingQuestion.questionId,
            toolcallId: pendingQuestion.toolcallId,
            answers,
            cancelled: false,
        });
    }, [sendResponse, pendingQuestion]);

    const handleStop = useStopRun('AskUserQuestionPanel');

    return (
        <AskUserQuestionCard
            pendingQuestion={pendingQuestion}
            onSubmit={handleSubmit}
            onStop={handleStop}
            disabled={isReconnecting}
            heldCaption={reconnectShown ? RECONNECT_HELD_CAPTION : undefined}
        />
    );
};

export default AskUserQuestionPanel;
