/**
 * The chat state a run session owns.
 *
 * These atoms live in the session's private store, which is their authority.
 * A window holds copies of them for rendering, applied by the run projection
 * (`react/runtime/runProjection.ts`); it changes them only through its
 * session's port. Everything else a run touches in the window (agent actions,
 * warnings, popups, citation markers, composer) stays the window's and is
 * reached through the run host.
 *
 * Only primitive atoms belong here. Derived atoms are computed by each store
 * from these.
 *
 * The window and the plugin realm each evaluate these modules, so an atom is
 * a different object in each: the two sides name them instead
 * (`sessionAtomByName`, `sessionAtomName`).
 */

import type { PrimitiveAtom, WritableAtom } from 'jotai/vanilla';
import {
    activeRunAtom,
    currentThreadIdAtom,
    currentThreadNameAtom,
    threadRunsAtom,
    wsReconnectingAtom,
    wsRetryAtom,
} from '@beaver/agent-core/run-state/atoms';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import { clearAllPendingQuestionsAtom, pendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import { clearAllPendingBatchApprovalsAtom, pendingBatchApprovalsAtom } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import {
    clearAllPendingCreditConfirmationsAtom,
    pendingCreditConfirmationsAtom,
    removePendingCreditConfirmationAtom,
} from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import { clearAllPendingTableCardsAtom, pendingTableCardsAtom, tableCardDraftsAtom } from '@beaver/agent-core/run-state/pendingTableCards';
import { reattachResolutionAtom, runReplacementNotesAtom } from '@beaver/agent-core/run-state/runResolution';
import { streamQuietAtom } from '@beaver/agent-core/run-state/streamActivity';
import { clearAllPendingApprovalsAtom, pendingApprovalsAtom, removePendingApprovalAtom } from './pendingApprovals';
import {
    clearParkedAnswersAtom,
    syncParkedCardsAtom,
    liveCardAnswersAtom,
    parkedAnswerQueueAtom,
    parkedAnswersInFlightAtom,
    resumeLiveCardsAtom,
    setAsideParkedCardsAtom,
} from './parkedRuns';
import { clearRunApprovalPolicyAtom, grantCreatedNoteEditsForRunAtom, runApprovalPolicyAtom } from './runApprovalPolicy';
import { registeredSessionActions } from './sessionActions';
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

type SessionWriteAtom = WritableAtom<unknown, any[], unknown>;

let writeEntries: ReadonlyArray<readonly [string, SessionWriteAtom]> | null = null;

/**
 * Write atoms of session state that window code sets on its session (besides
 * the engine's named actions, `sessionActions.ts`).
 */
function sessionWriteAtoms(): ReadonlyArray<readonly [string, SessionWriteAtom]> {
    writeEntries ??= Object.entries({
        clearAllPendingApprovals: clearAllPendingApprovalsAtom,
        removePendingApproval: removePendingApprovalAtom,
        clearAllPendingQuestions: clearAllPendingQuestionsAtom,
        clearAllPendingBatchApprovals: clearAllPendingBatchApprovalsAtom,
        clearAllPendingCreditConfirmations: clearAllPendingCreditConfirmationsAtom,
        removePendingCreditConfirmation: removePendingCreditConfirmationAtom,
        clearAllPendingTableCards: clearAllPendingTableCardsAtom,
        clearParkedAnswers: clearParkedAnswersAtom,
        syncParkedCards: syncParkedCardsAtom,
        clearRunApprovalPolicy: clearRunApprovalPolicyAtom,
        grantCreatedNoteEditsForRun: grantCreatedNoteEditsForRunAtom,
    } as Record<string, SessionWriteAtom>);
    return writeEntries;
}

let byName: Map<string, SessionWriteAtom> | null = null;
let names: WeakMap<object, string> | null = null;

function buildNameTables(): void {
    if (byName && names) return;
    const all: Array<readonly [string, SessionWriteAtom]> = [
        ...sessionStateAtoms(),
        ...sessionWriteAtoms(),
        ...registeredSessionActions(),
    ];
    byName = new Map();
    names = new WeakMap();
    for (const [name, atom] of all) {
        if (byName.has(name)) throw new Error(`Session atom name "${name}" is used twice`);
        byName.set(name, atom);
        names.set(atom, name);
    }
}

/** This realm's atom for a session atom or action name; throws for an unknown name. */
export function sessionAtomByName(name: string): SessionWriteAtom {
    buildNameTables();
    const atom = byName!.get(name);
    if (!atom) throw new Error(`Unknown session atom "${name}"`);
    return atom;
}

/** The name of a session atom or action of this realm; throws for any other atom. */
export function sessionAtomName(atom: object): string {
    buildNameTables();
    const name = names!.get(atom);
    if (!name) throw new Error('Not a session atom: window code may only reach session state it names');
    return name;
}
