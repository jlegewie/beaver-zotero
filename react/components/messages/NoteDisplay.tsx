import React, { useCallback, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { truncateText } from '../../utils/stringUtils';
import { isLibraryEditable } from '../../../src/utils/zoteroUtils';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import {
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    CopyIcon,
    Spinner,
    PlusSignIcon
} from '../icons/icons';
import MarkdownRenderer from './MarkdownRenderer';
import {
    ackProposedActionsAtom,
    getProposedActionByIdAtom,
    rejectProposedActionStateAtom,
    setProposedActionsToErrorAtom
} from '../../atoms/proposedActions';
import { isZoteroNoteAction } from '../../types/proposedActions/base';
import { createZoteroItemReference, ZoteroItemReference } from '../../types/zotero';
import { saveStreamingNote } from '../../utils/noteActions';
import {
    notePanelStateAtom,
    defaultNotePanelState,
    setNotePanelStateAtom,
    toggleNotePanelVisibilityAtom
} from '../../atoms/messageUIState';
import { ZOTERO_ICONS, ZoteroIcon } from '../icons/ZoteroIcon';
import { copyToClipboard } from '../../utils/clipboard';
import Tooltip from '../ui/Tooltip';

export interface StreamingNoteBlock {
    id: string;
    title?: string;
    itemId?: string | null;
    attributes: Record<string, string>;
    content: string;
    isComplete: boolean;
}

interface NoteDisplayProps {
    note: StreamingNoteBlock;
    messageId?: string;
    exportMode?: boolean;
}

type NoteStatus =
    | 'pending'
    | 'applied'
    | 'rejected'
    | 'undone'
    | 'error'
    | 'missing';

interface NoteHeaderProps {
    status: NoteStatus;
    isSaving: boolean;
    isComplete: boolean;
    noteTitle: string;
    contentVisible: boolean;
    hasContent: boolean;
    canToggleContent: boolean;
    toggleContent: () => void;
    handleSave: () => void;
    isLibraryReadOnly: boolean;
}

const NoteHeader = React.memo(function NoteHeader(props: NoteHeaderProps) {
    const {
        status,
        isSaving,
        isComplete,
        noteTitle,
        contentVisible,
        hasContent,
        canToggleContent,
        toggleContent,
        handleSave,
        isLibraryReadOnly
    } = props;

    const [isButtonHovered, setIsButtonHovered] = useState(false);

    // Memoize the header icon to prevent recomputation on every render
    const HeaderIcon = useMemo(() => {
        if (isSaving) return Spinner;
        if (!isComplete) return Spinner;
        if (isButtonHovered && !contentVisible) return ArrowRightIcon;
        if (isButtonHovered && contentVisible) return ArrowDownIcon;
        return () => <ZoteroIcon icon={ZOTERO_ICONS.NOTES} size={12} className="-mr-0035"/>;
    }, [isSaving, status, isComplete, isButtonHovered, contentVisible]);

    const headerText = useMemo(() => {
        return truncateText(noteTitle, 40);
    }, [noteTitle]);

    return (
        <div
            className={`display-flex flex-row bg-senary items-start py-15 px-25 ${contentVisible && hasContent ? 'border-bottom-quinary' : ''}`}
            onMouseEnter={() => setIsButtonHovered(true)}
            onMouseLeave={() => setIsButtonHovered(false)}
        >
            {/* Header */}
            <div className="display-flex flex-row flex-1 gap-3">
                <IconButton
                    icon={HeaderIcon}
                    // className="mt-015"
                    variant="ghost-secondary"
                    onClick={toggleContent}
                    disabled={!canToggleContent}
                    title="Toggle content"
                />
                <Button
                    variant="ghost-secondary"
                    // icon={HeaderIcon}
                    onClick={toggleContent}
                    className={`
                        text-base scale-105 truncate
                        ${!canToggleContent ? 'disabled-but-styled' : ''}
                        ${status === 'error' ? 'font-color-warning' : ''}
                    `}
                    disabled={!canToggleContent}
                >
                    <span>{headerText}</span>
                </Button>
                <div className="flex-1" />
            </div>

            {/* Action buttons */}
            <div className="display-flex flex-row gap-3">
                {status == 'pending'  && !isLibraryReadOnly && (
                    <Tooltip content="Save note to Zotero" showArrow singleLine>
                        <IconButton
                            icon={PlusSignIcon}
                            className="mt-1"
                            onClick={handleSave}
                            variant="ghost-secondary"
                            disabled={isSaving || !isComplete}
                        />
                    </Tooltip>
                )}
                {status == 'applied' && !isLibraryReadOnly && (
                    <Tooltip content="Reveal note in Zotero" showArrow singleLine>
                        <IconButton
                            icon={() => <ZoteroIcon icon={ZOTERO_ICONS.SHOW_ITEM} size={10} />}
                            className="mt-1"
                            // onClick={() => Zotero.getActiveZoteroPane().openNoteWindow(item.id)}
                            onClick={() => {}}
                            variant="ghost-secondary"
                        />
                    </Tooltip>
                )}
                {status === 'error' || isLibraryReadOnly && (
                    <Tooltip content={isLibraryReadOnly ? `Read-only library` : `Unable to save note`} showArrow singleLine>
                        <IconButton
                            icon={AlertIcon}
                            className="font-color-tertiary mt-1"
                            onClick={() => {}}
                            variant="ghost-secondary"
                            disabled={true}
                        />
                    </Tooltip>
                )}
                <Tooltip content="Copy" showArrow singleLine>
                    <IconButton
                        icon={CopyIcon}
                        className="mt-015"
                        variant="ghost-secondary"
                        onClick={() => copyToClipboard(noteTitle)}
                        disabled={isSaving || !isComplete}
                    />
                </Tooltip>
            </div>
        </div>
    );
}, (prevProps, nextProps) => {
    // Custom comparison: only re-render when these critical props change
    // This prevents re-renders during streaming content updates
    return (
        prevProps.status === nextProps.status &&
        prevProps.isSaving === nextProps.isSaving &&
        prevProps.isComplete === nextProps.isComplete &&
        prevProps.noteTitle === nextProps.noteTitle &&
        prevProps.contentVisible === nextProps.contentVisible &&
        prevProps.hasContent === nextProps.hasContent &&
        prevProps.canToggleContent === nextProps.canToggleContent
    );
});

interface NoteBodyProps {
    trimmedContent: string;
    contentVisible: boolean;
    hasContent: boolean;
}

const NoteBody = React.memo(function NoteBody(props: NoteBodyProps) {
    const { trimmedContent, contentVisible, hasContent } = props;

    if (!contentVisible || !hasContent) {
        return null;
    }

    return (
        <div className="display-flex flex-col p-25 gap-2 bg-senary">
            <div className="markdown note-body">
                <MarkdownRenderer 
                    content={trimmedContent || '_No content yet._'} 
                    enableNoteBlocks={false}
                />
            </div>
        </div>
    );
});

const NoteDisplay: React.FC<NoteDisplayProps> = ({ note, messageId, exportMode = false }) => {
    const getProposedActionById = useAtomValue(getProposedActionByIdAtom);
    const ackProposedActions = useSetAtom(ackProposedActionsAtom);
    const rejectProposedAction = useSetAtom(rejectProposedActionStateAtom);
    const setProposedActionsToError = useSetAtom(setProposedActionsToErrorAtom);

    // UI state for collapsible note panel
    const panelStates = useAtomValue(notePanelStateAtom);
    const panelState = panelStates[note.id] ?? defaultNotePanelState;
    const { contentVisible, isSaving } = panelState;

    const setNotePanelState = useSetAtom(setNotePanelStateAtom);
    const toggleNotePanelVisibility = useSetAtom(toggleNotePanelVisibilityAtom);

    const proposedAction = getProposedActionById(note.id);
    const noteAction = useMemo(() => {
        return proposedAction && isZoteroNoteAction(proposedAction) ? proposedAction : null;
    }, [proposedAction]);

    const status: NoteStatus = noteAction ? noteAction.status : 'missing';

    const noteTitle = note.title || noteAction?.proposed_data?.title || 'New note';
    const trimmedContent = note.content.replace(/^\n+/, '');

    const parentReference: ZoteroItemReference | null = useMemo(() => {
        if (
            noteAction?.proposed_data?.library_id !== undefined &&
            noteAction?.proposed_data?.zotero_key
        ) {
            return {
                library_id: noteAction.proposed_data.library_id as number,
                zotero_key: noteAction.proposed_data.zotero_key
            };
        }
        if (note.itemId) {
            return createZoteroItemReference(note.itemId);
        }
        return null;
    }, [noteAction, note.itemId]);

    // Toggle visibility of note content
    const toggleContent = useCallback(() => {
        toggleNotePanelVisibility(note.id);
    }, [note.id, toggleNotePanelVisibility]);

    const targetLibraryId: number | undefined = parentReference?.library_id ?? noteAction?.proposed_data?.library_id ?? undefined;

    const canSave =
        !exportMode &&
        Boolean(messageId) &&
        note.isComplete &&
        noteAction !== null &&
        ['pending', 'error', 'rejected', 'undone'].includes(status);

    const handleSave = useCallback(async () => {
        if (!noteAction || !messageId || !note.isComplete) {
            return;
        }
        setNotePanelState({ key: note.id, updates: { isSaving: true } });
        try {
            const noteContent = `<h1>${noteTitle}</h1>\n\n${trimmedContent || note.content}`;
            const result = await saveStreamingNote({
                markdownContent: noteContent,
                title: noteTitle,
                parentReference,
                targetLibraryId
            });
            await ackProposedActions(messageId, [
                {
                    action_id: noteAction.id,
                    result_data: result
                }
            ]);
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to save note';
            setProposedActionsToError([noteAction.id], errorMessage);
        } finally {
            setNotePanelState({ key: note.id, updates: { isSaving: false } });
        }
    }, [ackProposedActions, messageId, note.id, note.content, note.isComplete, noteAction, noteTitle, parentReference, setProposedActionsToError, setNotePanelState, trimmedContent]);

    // Determine when content can be toggled
    const canToggleContent = note.isComplete;
    const hasContent = trimmedContent.length > 0;

    return (
        <div
            className={`${contentVisible && hasContent ? 'border-popup' : 'border-quinary'} rounded-md display-flex flex-col min-w-0`}
        >
            <NoteHeader
                status={status}
                isSaving={isSaving}
                isComplete={note.isComplete}
                noteTitle={noteTitle}
                contentVisible={contentVisible}
                hasContent={hasContent}
                canToggleContent={canToggleContent}
                toggleContent={toggleContent}
                handleSave={handleSave}
                isLibraryReadOnly={targetLibraryId ? !isLibraryEditable(targetLibraryId) : true}
            />
            <NoteBody
                trimmedContent={trimmedContent}
                contentVisible={contentVisible}
                hasContent={hasContent}
            />
        </div>
    );
};

export default NoteDisplay;

