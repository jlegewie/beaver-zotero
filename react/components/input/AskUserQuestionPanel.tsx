import React, { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import type { PendingQuestion } from '@beaver/agent-core/run-state/pendingQuestions';
import type { AskUserQuestionAnswer } from '@beaver/agent-core/protocol/agentProtocol';
import { hasAnyAnswer } from '@beaver/agent-core/run-state/askUserQuestionAnswers';
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
 * the question and toolcall ids the request arrived with. Three outcomes leave
 * the run alive: a submit, a skip (a response with nothing answered), and the
 * card's own countdown running out (a cancel flagged `timed_out`, carrying
 * whatever the user had picked so far). Stop cancels the run outright by
 * closing that connection.
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

    // The card expired with the draft as it stood. Anything the user did pick
    // is their answer, so it goes out as one — `cancelled` only when nothing
    // was picked — and `timedOut` tells the backend the rest fell to the clock,
    // not to a skip. A backend that predates the flag reads the same message
    // as a plain submit or skip, which is the right fallback either way.
    const handleExpire = useCallback((answers: AskUserQuestionAnswer[]) => {
        const answered = hasAnyAnswer(answers);
        logger(`AskUserQuestionPanel: Question card expired ${answered ? 'with partial answers' : 'without an answer'}`);
        sendResponse({
            questionId: pendingQuestion.questionId,
            toolcallId: pendingQuestion.toolcallId,
            answers,
            cancelled: !answered,
            timedOut: true,
        });
    }, [sendResponse, pendingQuestion]);

    const handleStop = useCallback(() => {
        logger('AskUserQuestionPanel: Stopping run while question pending');
        closeWSConnection(); // Also clears pending questions -> panel unmounts
    }, [closeWSConnection]);

    return (
        <AskUserQuestionCard
            key={pendingQuestion.questionId}
            pendingQuestion={pendingQuestion}
            onSubmit={handleSubmit}
            onExpire={handleExpire}
            onStop={handleStop}
        />
    );
};

export default AskUserQuestionPanel;
