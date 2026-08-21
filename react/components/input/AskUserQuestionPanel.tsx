import React, { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import type { PendingQuestion } from '@beaver/agent-core/run-state/pendingQuestions';
import type { AskUserQuestionAnswer } from '@beaver/agent-core/protocol/agentProtocol';
import {
    closeWSConnectionAtom,
    sendAskUserQuestionResponseAtom,
} from '../../atoms/agentRunAtoms';
import AskUserQuestionCard from '@beaver/agent-ui/chat/AskUserQuestionCard';
import { logger } from '@beaver/agent-core/platform/logger';

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
    const closeWSConnection = useSetAtom(closeWSConnectionAtom);

    const handleSubmit = useCallback((answers: AskUserQuestionAnswer[]) => {
        sendResponse({
            questionId: pendingQuestion.questionId,
            toolcallId: pendingQuestion.toolcallId,
            answers,
            cancelled: false,
        });
    }, [sendResponse, pendingQuestion]);

    const handleStop = useCallback(() => {
        logger('AskUserQuestionPanel: Stopping run while question pending');
        closeWSConnection(); // Also clears pending questions -> panel unmounts
    }, [closeWSConnection]);

    return (
        <AskUserQuestionCard
            pendingQuestion={pendingQuestion}
            onSubmit={handleSubmit}
            onStop={handleStop}
        />
    );
};

export default AskUserQuestionPanel;
