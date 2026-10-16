import React, { useCallback, useEffect, useState } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { DownloadIcon } from '@beaver/agent-ui/icons';
import type { FileExportFormat } from '@beaver/agent-ui/host/types';
import {
    agentActionItemTitlesAtom,
    getAgentActionItemTitleKey,
    setAgentActionItemTitleAtom,
} from '../../../../atoms/messageUIState';
import { ArrowUpRightIcon, EditIcon, Icon } from '../../../../components/icons/icons';
import { openNoteByKey } from '../../../../utils/sourceUtils';
import { resolveLibraryRef } from '../../../../../src/utils/libraryIdentity';
import { exportWithFeedback, fileExportFormatMenuItems } from '../../../../utils/fileExportFeedback';
import { addPopupMessageAtom } from '../../../../utils/popupMessageUtils';
import { notifyReferenceUnavailable } from '../../sourceActions';
import { exportNoteToFile, openExportedFile, revealExportedFile } from '../../fileExport';
import { getEditedNoteHeading, type NoteEditSummary } from '../reviewChangeRows';
import { countPendingNoteEdits } from './useRunActionRows';

interface EditedNoteArtifactRowProps {
    summary: NoteEditSummary;
}

/**
 * One note the answer edited, in the artifacts list: laid out like
 * `ReviewActionRow` inside its group, with the note's title, how many of the
 * answer's changes it holds, and Export and Open, both of which act on the note
 * as it is now. The edits themselves are reviewed and undone in the changes
 * card; this row is for the note they produced.
 */
export const EditedNoteArtifactRow: React.FC<EditedNoteArtifactRowProps> = ({ summary }) => {
    const { note } = summary;
    const { label, detail } = getEditedNoteHeading(summary);

    // The in-stream edit card caches the note's title under its tool call;
    // without that card (a collapsed or reloaded thread) the row looks it up.
    const titleKey = getAgentActionItemTitleKey(summary.runId, summary.toolcallId);
    const title = useAtomValue(agentActionItemTitlesAtom)[titleKey] ?? null;
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

    const handleOpen = useCallback(async () => {
        // Resolve through the device-portable library_ref so a note in a group
        // library opens the right local item.
        const libraryId = resolveLibraryRef(note);
        if (!libraryId) {
            notifyReferenceUnavailable('item', 'library_unavailable');
        } else if (!Zotero.Items.getIDFromLibraryAndKey(libraryId, note.zotero_key)) {
            notifyReferenceUnavailable('item', 'missing');
        } else {
            await openNoteByKey(libraryId, note.zotero_key);
        }
    }, [note]);

    const [isExporting, setIsExporting] = useState(false);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);
    const jotaiStore = useStore();
    const handleExport = useCallback(async (format: FileExportFormat) => {
        if (isExporting) return;
        setIsExporting(true);
        try {
            await exportWithFeedback(
                format,
                () => exportNoteToFile({
                    format,
                    surface: 'run_artifacts',
                    note,
                    // Every unapplied edit in the thread, not only this answer's.
                    pendingChanges: countPendingNoteEdits(jotaiStore, note),
                }),
                addPopupMessage,
                { reveal: revealExportedFile, open: openExportedFile },
            );
        } finally {
            setIsExporting(false);
        }
    }, [isExporting, note, addPopupMessage, jotaiStore]);

    return (
        <div className="display-flex flex-row items-center py-15 gap-1 min-w-0">
            <div
                className="display-flex flex-row items-start ml-3 gap-2 min-w-0"
                style={{ fontSize: '0.95rem' }}
            >
                <div className="display-flex items-center scale-11 mt-010 font-color-secondary" style={{ flexShrink: 0 }}>
                    <Icon icon={EditIcon} />
                </div>
                <div
                    className="min-w-0"
                    style={{
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        wordBreak: 'break-word',
                    }}
                >
                    <span className="font-color-primary font-medium">{label}</span>
                    {title && <span className="font-color-secondary ml-15">{title}</span>}
                    <span className="font-color-tertiary ml-15">{detail}</span>
                </div>
            </div>

            <div className="flex-1" />

            <div className="display-flex flex-row items-center gap-2 mr-3 mt-010" style={{ flexShrink: 0 }}>
                {isExporting ? (
                    <IconButton
                        icon={DownloadIcon}
                        variant="ghost-secondary"
                        iconClassName="font-color-secondary scale-10"
                        onClick={() => {}}
                        loading
                        ariaLabel="Exporting"
                    />
                ) : (
                    <MenuButton
                        icon={DownloadIcon}
                        variant="ghost-secondary"
                        iconClassName="font-color-secondary scale-10"
                        menuItems={fileExportFormatMenuItems(handleExport)}
                        tooltipContent="Export"
                        ariaLabel="Export"
                    />
                )}
                <Tooltip content="Open note" showArrow singleLine>
                    <IconButton
                        icon={ArrowUpRightIcon}
                        variant="ghost-secondary"
                        iconClassName="font-color-secondary scale-10"
                        onClick={handleOpen}
                        ariaLabel="Open note"
                    />
                </Tooltip>
            </div>
        </div>
    );
};

export default EditedNoteArtifactRow;
