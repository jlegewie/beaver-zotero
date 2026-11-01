import { useMemo } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { agentActionsForRunsAtom, liveApprovalActionIdsForRunsAtom, threadAgentActionsAtom } from '../../../../agents/agentActions';
import { libraryRefForLibraryID, parseLibraryRef, resolveLibraryRef } from '../../../../../src/utils/libraryIdentity';
import {
    buildEditedNoteArtifacts,
    buildReviewRowsForRunChain,
    NoteEditSummary,
    OpenNoteTarget,
    pendingNoteChanges,
    ReviewRow,
    RunActionRowSet,
    summarizeNoteEdits,
} from '../reviewChangeRows';

/**
 * Action ids the in-stream card and PendingActionsBar own. Only these runs'
 * ids, the only ones their rows ask about, so an approval elsewhere in the
 * thread leaves the answer's review surfaces alone.
 */
function useLiveApprovalActionIds(runIds: string[]): ReadonlySet<string> {
    return useAtomValue(useMemo(() => liveApprovalActionIdsForRunsAtom(runIds), [runIds]));
}

/**
 * One answer's rows for one bottom-of-run surface, pending or settled. A
 * continued answer can span several durable run records.
 *
 * A hook rather than component-internal state so the surrounding review block
 * can tell whether a surface has anything to show: an empty one still counts as
 * a flex item in the run column and would add a `gap-2` row of blank space.
 */
function useActionsByRun(runIds: string[]) {
    // Scoped to these runs: an action written elsewhere in the thread leaves the
    // answer's review surfaces alone.
    return useAtomValue(useMemo(() => agentActionsForRunsAtom(runIds), [runIds]));
}

function useRunActionRows(runIds: string[], include: RunActionRowSet): ReviewRow[] {
    const liveApprovalActionIds = useLiveApprovalActionIds(runIds);
    const actionsByRun = useActionsByRun(runIds);

    return useMemo(
        () => buildReviewRowsForRunChain(actionsByRun, { liveApprovalActionIds, include }),
        [actionsByRun, include, liveApprovalActionIds],
    );
}

/** What the answer did to the library, for `ChangesCard`. Excludes artifacts. */
export function useChangesRows(runIds: string[]): ReviewRow[] {
    return useRunActionRows(runIds, 'changes');
}

/** What the answer produced for the user to open, for `ArtifactsList`. */
export function useArtifactRows(runIds: string[]): ReviewRow[] {
    return useRunActionRows(runIds, 'artifacts');
}

/**
 * The notes the answer edited without creating them, for `ArtifactsList`. The
 * edits that count are the answer's own; live approvals belong to the
 * in-stream card until they are decided.
 */
export function useEditedNoteArtifacts(runIds: string[]): NoteEditSummary[] {
    const liveApprovalActionIds = useLiveApprovalActionIds(runIds);
    const actionsByRun = useActionsByRun(runIds);
    return useMemo(
        () => buildEditedNoteArtifacts(actionsByRun, { liveApprovalActionIds, completeNoteIdentity }),
        [actionsByRun, liveApprovalActionIds],
    );
}

/**
 * Edits to a note anywhere in the thread that are not applied yet, including
 * ones awaiting approval in the stream, for an export to mention. Read when
 * the export starts, from the store of the surface that started it.
 */
export function countPendingNoteEdits(store: ReturnType<typeof useStore>, note: OpenNoteTarget): number {
    const summaries = summarizeNoteEdits([store.get(threadAgentActionsAtom)], { completeNoteIdentity });
    return pendingNoteChanges(summaries, completeNoteIdentity(note));
}

/**
 * A note target with both of its library identities as this device knows
 * them. The portable ref decides: a stored library id is only valid on the
 * device that recorded it, so it is re-resolved from the ref and left out
 * when that library is not on this device. A target with only a library id
 * (older history) gets the ref of that local library. Lets edits that name
 * one note in different ways count as one note.
 */
export function completeNoteIdentity(note: OpenNoteTarget): OpenNoteTarget {
    if (note.library_ref != null) {
        const libraryId = resolveLibraryRef({ library_ref: note.library_ref });
        if (libraryId != null) return { ...note, library_id: libraryId };
        // An unparseable ref falls back to the stored id; an unavailable
        // library has no local id at all.
        if (!parseLibraryRef(note.library_ref)) return note;
        return { library_ref: note.library_ref, zotero_key: note.zotero_key };
    }
    if (note.library_id != null) {
        const libraryRef = libraryRefForLibraryID(note.library_id);
        return libraryRef ? { ...note, library_ref: libraryRef } : note;
    }
    return note;
}
