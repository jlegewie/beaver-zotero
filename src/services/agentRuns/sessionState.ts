/**
 * The chat state a run session owns.
 *
 * These atoms live in the session's private store, which is their authority.
 * A window holds copies of them for rendering, applied by the run projection
 * (`react/runtime/runProjection.ts`); it changes them only through the session's store
 * (`runSessionStore()`). Everything else a run touches in the window (agent
 * actions, warnings, popups, citation markers, composer) stays the window's
 * and is reached through the run host.
 *
 * Only primitive atoms belong here. Derived atoms are computed by each store
 * from these.
 */

import type { PrimitiveAtom } from 'jotai/vanilla';
import {
    activeRunAtom,
    currentThreadIdAtom,
    currentThreadNameAtom,
    threadRunsAtom,
    wsReconnectingAtom,
    wsRetryAtom,
} from '@beaver/agent-core/run-state/atoms';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import { pendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import { pendingBatchApprovalsAtom } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import { pendingCreditConfirmationsAtom } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import { pendingTableCardsAtom, tableCardDraftsAtom } from '@beaver/agent-core/run-state/pendingTableCards';
import { reattachResolutionAtom, runReplacementNotesAtom } from '@beaver/agent-core/run-state/runResolution';
import { streamQuietAtom } from '@beaver/agent-core/run-state/streamActivity';
import { pendingApprovalsAtom } from './pendingApprovals';
import {
    liveCardAnswersAtom,
    parkedAnswerQueueAtom,
    parkedAnswersInFlightAtom,
    resumeLiveCardsAtom,
    setAsideParkedCardsAtom,
} from './parkedRuns';
import { runApprovalPolicyAtom } from './runApprovalPolicy';
import { jobWaitAtom } from './jobWait';
import { admissionUnreachableThreadAtom, threadAdmissionAtom, threadConflictAtom } from './threadAdmission';
import { viewedHistoryRevisionAtom } from './threadAdmission';
import {
    approvalResponseIntentsAtom,
    approvalVerdictInFlightAtom,
    isWSChatPendingAtom,
    isWSConnectedAtom,
    isWSReadyAtom,
    retryPendingRunIdAtom,
    scheduledAutoResumeRunIdsAtom,
    staleApprovalActionIdsAtom,
    stoppingPreviousRunAtom,
    streamingDoneRunIdsAtom,
    wsErrorAtom,
    wsReadyDataAtom,
    wsRequestAckDataAtom,
    wsWarningAtom,
} from './runEngine';

export type SessionStateAtom = PrimitiveAtom<any>;

let entries: ReadonlyArray<readonly [string, SessionStateAtom]> | null = null;

/**
 * The session's state atoms with their names. Built on first use: the modules
 * that define them import one another.
 */
export function sessionStateAtoms(): ReadonlyArray<readonly [string, SessionStateAtom]> {
    entries ??= Object.entries({
        // The chat and its runs.
        currentThreadId: currentThreadIdAtom,
        currentThreadName: currentThreadNameAtom,
        threadRuns: threadRunsAtom,
        activeRun: activeRunAtom,
        citations: citationsAtom,
        // Decision cards and their answers.
        pendingApprovals: pendingApprovalsAtom,
        pendingQuestions: pendingQuestionsAtom,
        pendingBatchApprovals: pendingBatchApprovalsAtom,
        pendingCreditConfirmations: pendingCreditConfirmationsAtom,
        pendingTableCards: pendingTableCardsAtom,
        tableCardDrafts: tableCardDraftsAtom,
        approvalResponseIntents: approvalResponseIntentsAtom,
        staleApprovalActionIds: staleApprovalActionIdsAtom,
        approvalVerdictInFlight: approvalVerdictInFlightAtom,
        runApprovalPolicy: runApprovalPolicyAtom,
        liveCardAnswers: liveCardAnswersAtom,
        resumeLiveCards: resumeLiveCardsAtom,
        parkedAnswerQueue: parkedAnswerQueueAtom,
        parkedAnswersInFlight: parkedAnswersInFlightAtom,
        setAsideParkedCards: setAsideParkedCardsAtom,
        jobWait: jobWaitAtom,
        // Server admission and settlement.
        threadAdmission: threadAdmissionAtom,
        threadConflict: threadConflictAtom,
        admissionUnreachableThread: admissionUnreachableThreadAtom,
        reattachResolution: reattachResolutionAtom,
        runReplacementNotes: runReplacementNotesAtom,
        viewedHistoryRevision: viewedHistoryRevisionAtom,
        // Connection and run lifecycle.
        isWSChatPending: isWSChatPendingAtom,
        isWSConnected: isWSConnectedAtom,
        isWSReady: isWSReadyAtom,
        wsReadyData: wsReadyDataAtom,
        wsRequestAckData: wsRequestAckDataAtom,
        wsError: wsErrorAtom,
        wsWarning: wsWarningAtom,
        wsRetry: wsRetryAtom,
        wsReconnecting: wsReconnectingAtom,
        streamingDoneRunIds: streamingDoneRunIdsAtom,
        streamQuiet: streamQuietAtom,
        retryPendingRunId: retryPendingRunIdAtom,
        stoppingPreviousRun: stoppingPreviousRunAtom,
        scheduledAutoResumeRunIds: scheduledAutoResumeRunIdsAtom,
    } satisfies Record<string, SessionStateAtom>);
    return entries;
}
