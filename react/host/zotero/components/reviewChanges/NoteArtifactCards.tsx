import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import type { FileExportFormat, FileExportResult } from '@beaver/agent-ui/host/types';
import {
    agentActionItemTitleAtom,
    getAgentActionItemTitleKey,
    setAgentActionItemTitleAtom,
} from '../../../../atoms/messageUIState';
import { NoteIcon } from '../../../../components/icons/icons';
import { UNRESOLVED_LIBRARY_ID } from '@beaver/agent-core/identity/libraryRef';
import { openSource } from '../../../../utils/sourceUtils';
import { resolveLibraryRef } from '../../../../../src/utils/libraryIdentity';
import { exportWithFeedback, fileExportFormatMenuItems } from '../../../../utils/fileExportFeedback';
import { addPopupMessageAtom } from '../../../../utils/popupMessageUtils';
import { exportNoteToFile, openExportedFile, revealExportedFile } from '../../fileExport';
import { applyAgentActionsAtom, inFlightAgentActionIdsAtom, rejectAgentActionsAtom } from '../../agentActionExecution';
import { getExportNoteTarget, type NoteEditSummary, type OpenNoteTarget, type ReviewRow } from '../reviewChangeRows';
import { countPendingNoteEdits } from './useRunActionRows';
import { createdNoteCard, editedNoteCondition } from './runArtifacts';
import { RunArtifactCard, RunArtifactExportButton, RunArtifactOpenButton } from './RunArtifactCard';

/** Opens a note, or says why it cannot be opened (its library is not here, or it is gone). */
function openNote(note: OpenNoteTarget): Promise<void> {
    return openSource({ ...note, library_id: note.library_id ?? UNRESOLVED_LIBRARY_ID });
}

/** A note card's Export: the note as it is now, in the format picked, with the usual feedback. */
function useNoteExport(exportFile: (format: FileExportFormat) => Promise<FileExportResult>) {
    const [exporting, setExporting] = useState(false);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);
    const handleExport = useCallback(async (format: FileExportFormat) => {
        if (exporting) return;
        setExporting(true);
        try {
            await exportWithFeedback(format, () => exportFile(format), addPopupMessage, {
                reveal: revealExportedFile,
                open: openExportedFile,
            });
        } finally {
            setExporting(false);
        }
    }, [exporting, exportFile, addPopupMessage]);
    return { exporting, items: fileExportFormatMenuItems((format) => void handleExport(format)) };
}

/**
 * A note the answer created, as an artifact card: its title, then what kind
 * of note it is and how long, or why it is not in the library. A note in the
 * library opens from anywhere on the card and offers Export and Open. A
 * proposal nobody decided offers Create and Reject, a rejected or undone one
 * Create again, a failed one Try again. Deleting it stays on the note's card
 * in the response.
 */
export const CreatedNoteCard: React.FC<{ row: ReviewRow }> = ({ row }) => {
    const card = createdNoteCard(row);
    const applyAgentActions = useSetAtom(applyAgentActionsAtom);
    const rejectAgentActions = useSetAtom(rejectAgentActionsAtom);
    const inFlight = useAtomValue(inFlightAgentActionIdsAtom);
    const writing = row.actions.some((action) => inFlight.has(action.id));
    const [clicked, setClicked] = useState(false);
    const busy = clicked || writing;
    const jotaiStore = useStore();

    // A note whose undo did not finish is still in the library, and opens too.
    const openTarget = card.move === 'open' ? getExportNoteTarget(row) : null;
    const handleOpen = useCallback(() => {
        if (openTarget) void openNote(openTarget);
    }, [openTarget]);

    const { exporting, items } = useNoteExport(
        useCallback((format: FileExportFormat) => {
            const note = getExportNoteTarget(row);
            return exportNoteToFile({
                format,
                surface: 'run_artifacts',
                note,
                createdBy: { runId: row.runId, toolCallId: row.toolcallId },
                pendingChanges: note ? countPendingNoteEdits(jotaiStore, note) : 0,
            });
        }, [row, jotaiStore]),
    );

    const handleApply = useCallback(async () => {
        setClicked(true);
        try {
            await applyAgentActions({ actions: row.actions, runId: row.runId });
        } finally {
            setClicked(false);
        }
    }, [row, applyAgentActions]);

    const handleReject = useCallback(() => {
        rejectAgentActions({ actions: row.actions.filter((action) => action.status === 'pending') });
    }, [row, rejectAgentActions]);

    const open = !!openTarget && !busy;
    const decide = (label: string) => (
        <Button
            variant="outline"
            onClick={() => void handleApply()}
            disabled={busy}
            loading={busy}
            className="flex-none whitespace-nowrap"
        >
            {label}
        </Button>
    );

    return (
        <RunArtifactCard
            icon={NoteIcon}
            headline={card.headline}
            condition={card.condition}
            warning={card.warning}
            onActivate={open ? handleOpen : undefined}
            activateLabel={`Open note ${card.headline}`}
            actions={
                <>
                    {card.move === 'decide' && (
                        <>
                            <Button
                                variant="ghost-secondary"
                                onClick={handleReject}
                                disabled={busy}
                                className="flex-none whitespace-nowrap"
                            >
                                Reject
                            </Button>
                            {decide('Create')}
                        </>
                    )}
                    {card.move === 'recreate' && decide(row.actions[0].status === 'undone' ? 'Create again' : 'Create')}
                    {card.move === 'retry' && decide('Try again')}
                    {card.move === 'open' && (
                        <>
                            <RunArtifactExportButton items={items} exporting={exporting} />
                            {openTarget && <RunArtifactOpenButton label="Open note" onClick={handleOpen} />}
                        </>
                    )}
                </>
            }
        />
    );
};

/**
 * A note the answer edited without creating it: its title, how many of the
 * answer's changes it holds, and Export and Open, both on the note as it is
 * now; a click anywhere on the card opens it. The edits themselves are
 * reviewed and undone in the changes card.
 */
export const EditedNoteCard: React.FC<{ summary: NoteEditSummary }> = ({ summary }) => {
    const { note } = summary;

    // The in-stream edit card caches the note's title under its tool call;
    // without that card (a collapsed or reloaded thread) the card looks it up.
    const titleKey = getAgentActionItemTitleKey(summary.runId, summary.toolcallId);
    const title = useAtomValue(useMemo(() => agentActionItemTitleAtom(titleKey), [titleKey]));
    const setItemTitle = useSetAtom(setAgentActionItemTitleAtom);
    useEffect(() => {
        if (title) return;
        const libraryId = resolveLibraryRef(note);
        if (!libraryId) return;
        let cancelled = false;
        (async () => {
            try {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, note.zotero_key);
                if (!item || cancelled || !item.isNote()) return;
                // A note's title loads with its item data.
                await item.loadDataType('itemData');
                if (cancelled) return;
                setItemTitle({ key: titleKey, title: item.getNoteTitle() || '(untitled)' });
            } catch {
                /* best-effort */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [title, note, titleKey, setItemTitle]);

    const handleOpen = useCallback(() => void openNote(note), [note]);
    const jotaiStore = useStore();
    const { exporting, items } = useNoteExport(
        useCallback((format: FileExportFormat) => exportNoteToFile({
            format,
            surface: 'run_artifacts',
            note,
            // Every unapplied edit in the thread, not only this answer's.
            pendingChanges: countPendingNoteEdits(jotaiStore, note),
        }), [note, jotaiStore]),
    );

    const headline = title || 'Note';
    return (
        <RunArtifactCard
            icon={NoteIcon}
            headline={headline}
            condition={editedNoteCondition(summary)}
            onActivate={handleOpen}
            activateLabel={`Open note ${headline}`}
            actions={
                <>
                    <RunArtifactExportButton items={items} exporting={exporting} />
                    <RunArtifactOpenButton label="Open note" onClick={handleOpen} />
                </>
            }
        />
    );
};
