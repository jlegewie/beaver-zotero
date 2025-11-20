import React, { useCallback, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { truncateText } from '../../utils/stringUtils';
import { getCurrentLibrary, isLibraryEditable } from '../../../src/utils/zoteroUtils';
import IconButton from '../ui/IconButton';
import {
    ArrowDownIcon,
    ArrowRightIcon,
    ArrowUpIcon,
    CopyIcon,
    Icon,
    Spinner,
    PlusSignIcon,
    TickIcon
} from '../icons/icons';
import MarkdownRenderer from './MarkdownRenderer';
import {
    ackProposedActionsAtom,
    getProposedActionByIdAtom,
    setProposedActionsToErrorAtom
} from '../../atoms/proposedActions';
import { isZoteroNoteAction } from '../../types/proposedActions/base';
import { ZoteroItemReference } from '../../types/zotero';
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
import { renderToMarkdown } from '../../utils/citationRenderers';
import { selectItem } from '../../../src/utils/selectItem';
import { getCurrentReaderItemAsync } from '../../utils/readerUtils';

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
    exportRendering?: boolean;
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
    handleCopy: () => void;
    revealNote: () => void;
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
        handleCopy,
        isLibraryReadOnly,
        revealNote
    } = props;

    const [isTitleHovered, setIsTitleHovered] = useState(false);
    const [showCopiedState, setShowCopiedState] = useState(false);
    const [showSavedState, setShowSavedState] = useState(false);

    const handleCopyClick = useCallback(() => {
        // if (showCopiedState) return;
        handleCopy();
        setShowCopiedState(true);
        setTimeout(() => {
            setShowCopiedState(false);
        }, 1250);
    }, [handleCopy]);

    const handleSaveClick = useCallback(() => {
        // if (showSavedState) return;
        handleSave();
        setShowSavedState(true);
        setTimeout(() => {
            setShowSavedState(false);
        }, 1250);
    }, [handleSave]);

    // Create a wrapper for Spinner that converts width/height props to size
    const SpinnerWrapper = useMemo(() => {
        return (props: React.SVGProps<SVGSVGElement>) => {
            // Extract size from width prop (Icon component passes width={size})
            const size = typeof props.width === 'number' ? props.width : 
                        typeof props.width === 'string' && props.width !== '1em' 
                            ? parseInt(props.width) || 12 : 12;
            const className = `${props.className || ''} mr-0085`.trim();
            return <Spinner size={size} className={className} />;
        };
    }, []);

    // Memoize the header icon to prevent recomputation on every render
    const HeaderIcon = useMemo(() => {
        if (isSaving) return SpinnerWrapper;
        if (!isComplete) return SpinnerWrapper;
        if (isTitleHovered && !contentVisible) return ArrowRightIcon;
        if (isTitleHovered && contentVisible) return ArrowDownIcon;
        return () => <ZoteroIcon icon={ZOTERO_ICONS.NOTES} size={12} className="mr-0085"/>;
    }, [isSaving, status, isComplete, isTitleHovered, contentVisible, SpinnerWrapper]);

    const headerText = useMemo(() => {
        return truncateText(noteTitle, 40);
    }, [noteTitle]);

    const isSaveDisabled = isSaving || !isComplete || isLibraryReadOnly;
    const saveTooltip = isLibraryReadOnly 
            ? "Library is read-only" 
            : "Create Zotero Note";

    return (
        <div
            className={`display-flex flex-row bg-senary items-start py-15 px-25 ${contentVisible && hasContent ? 'border-bottom-quinary' : ''}`}
        >
            {/* Header */}
            <div
                className={`display-flex flex-row flex-1 gap-25 items-start min-w-0 ${canToggleContent ? 'cursor-pointer' : ''}`}
                onMouseEnter={() => setIsTitleHovered(true)}
                onMouseLeave={() => setIsTitleHovered(false)}
                onClick={canToggleContent ? toggleContent : undefined}
                title={canToggleContent ? "Toggle content" : undefined}
            >
                <div className="mt-015" style={{ justifyContent: 'center' }}>
                    <Icon 
                        icon={HeaderIcon} 
                        className="font-color-secondary" 
                        size={12}
                    />
                </div>
                <div
                    className={`
                        text-base truncate font-color-secondary
                        ${!canToggleContent ? 'disabled-but-styled' : ''}
                        ${status === 'error' ? 'font-color-warning' : ''}
                    `}
                >
                    <span>{headerText}</span>
                </div>
                <div className="flex-1" />
            </div>

            {/* Action buttons */}
            <div className="display-flex flex-row gap-3">
                {/* <Tooltip content={saveTooltip} showArrow singleLine>
                    <IconButton
                        icon={status === 'applied' ? () => <ZoteroIcon icon={ZOTERO_ICONS.SHOW_ITEM} size={10} /> : PlusSignIcon}
                        className="mt-015"
                        variant="ghost-secondary"
                        onClick={status === 'applied' ? revealNote : handleSave}
                        disabled={status === 'applied' ? false : isSaveDisabled}
                    />
                </Tooltip> */}
                <Tooltip content={saveTooltip} showArrow singleLine>
                    <IconButton
                        icon={showSavedState ? TickIcon : PlusSignIcon}
                        className="mt-015"
                        variant="ghost-secondary"
                        onClick={handleSaveClick}
                        disabled={isSaveDisabled}
                    />
                </Tooltip>
                <Tooltip content="Copy" showArrow singleLine>
                    <IconButton
                        icon={showCopiedState ? TickIcon : CopyIcon}
                        className="mt-015"
                        variant="ghost-secondary"
                        onClick={handleCopyClick}
                        disabled={!isComplete}
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
        prevProps.canToggleContent === nextProps.canToggleContent &&
        prevProps.isLibraryReadOnly === nextProps.isLibraryReadOnly
    );
});

interface NoteBodyProps {
    trimmedContent: string;
    contentVisible: boolean;
    hasContent: boolean;
    toggleContent: () => void;
    exportRendering?: boolean;
}

const NoteBody = React.memo(function NoteBody(props: NoteBodyProps) {
    const { trimmedContent, contentVisible, hasContent, toggleContent, exportRendering = false } = props;
    const [isHovered, setIsHovered] = useState(false);

    if (!contentVisible || !hasContent) {
        return null;
    }

    return (
        <div className="display-flex flex-col bg-senary">
            <div className="display-flex flex-col px-25 pt-2 gap-2">
                <div className="markdown note-body">
                    <MarkdownRenderer 
                        content={trimmedContent || '_No content yet._'} 
                        enableNoteBlocks={false}
                        exportRendering={exportRendering}
                    />
                </div>
            </div>
            <div 
                className={`display-flex flex-row justify-center items-center cursor-pointer pb-1 ${isHovered ? 'bg-quinary' : ''}`}
                onClick={toggleContent}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <Icon
                    icon={ArrowUpIcon}
                    className={`scale-75 -mb-1 ${isHovered ? 'font-color-primary' : 'font-color-secondary'}`}
                />
            </div>
        </div>
    );
});

const NoteDisplay: React.FC<NoteDisplayProps> = ({ note, messageId, exportRendering = false }) => {
    const getProposedActionById = useAtomValue(getProposedActionByIdAtom);
    const ackProposedActions = useSetAtom(ackProposedActionsAtom);
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

    // Toggle visibility of note content
    const toggleContent = useCallback(() => {
        toggleNotePanelVisibility(note.id);
    }, [note.id, toggleNotePanelVisibility]);

    const handleCopy = useCallback(async () => {
        const formattedContent = renderToMarkdown(`# ${noteTitle}\n\n${trimmedContent || note.content}`);
        await copyToClipboard(formattedContent);
    }, [noteTitle, trimmedContent, note.content]);

    const revealNote = useCallback(async () => {
        if (noteAction?.result_data?.library_id && noteAction?.result_data?.zotero_key) {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(noteAction.result_data.library_id, noteAction.result_data.zotero_key);
            if (item) {
                // await Zotero.getActiveZoteroPane().openNoteWindow(item.id);
                await Zotero.getActiveZoteroPane().selectItem(item.id);
            }
        }
    }, [noteAction]);

    const handleSave = useCallback(async () => {
        if (!noteAction || !messageId || !note.isComplete) {
            return;
        }
        
        setNotePanelState({ key: note.id, updates: { isSaving: true } });
        try {
            const win = Zotero.getMainWindow();
            const zp = Zotero.getActiveZoteroPane();
            
            let targetLibId: number | undefined = undefined;
            let parentRef: ZoteroItemReference | null = null;
            let collectionToAddTo: Zotero.Collection | null = null;

            // Reader view
            const readerItem = await getCurrentReaderItemAsync(win);            
            if (readerItem) {
                targetLibId = readerItem.libraryID;
                parentRef = readerItem.parentKey
                    ? { library_id: readerItem.libraryID, zotero_key: readerItem.parentKey } as ZoteroItemReference
                    : null;

            // Library view
            } else {
                const selectedItems = zp.getSelectedItems();
                
                // If multiple selected, use the first one
                if (selectedItems.length >= 1) {
                    const firstItem = selectedItems[0];
                    const item = firstItem.isAnnotation() && firstItem.parentItem ? firstItem.parentItem : firstItem;
                    targetLibId = item.libraryID;
                    
                    if (item.isRegularItem()) {
                        parentRef = { library_id: item.libraryID, zotero_key: item.key } as ZoteroItemReference;
                    } else if (item.isNote() || item.isAttachment()) {
                        // Add to parent (sibling)
                        parentRef = item.parentKey
                            ? { library_id: item.libraryID, zotero_key: item.parentKey } as ZoteroItemReference
                            : null;
                    }

                // No selection or other cases (0 items) - add to current library/collection
                } else {
                    targetLibId = zp.getSelectedLibraryID();
                    const collection = zp.getSelectedCollection();
                    if (collection) {
                        collectionToAddTo = collection;
                    }
                    parentRef = null;
                }
            }

            if (!targetLibId) {
                throw new Error("Could not determine target library");
            }
            
            if (!isLibraryEditable(targetLibId)) {
                throw new Error("Library is read-only");
            }

            const noteContent = `<h1>${noteTitle}</h1>\n\n${trimmedContent || note.content}`;
            const result = await saveStreamingNote({
                markdownContent: noteContent,
                title: noteTitle,
                parentReference: parentRef,
                targetLibraryId: targetLibId
            });
            
            // Handle collection addition if needed
            if (collectionToAddTo && result.zotero_key) {
                 const newItem = await Zotero.Items.getByLibraryAndKeyAsync(result.library_id, result.zotero_key);
                 if (newItem) {
                     await Zotero.DB.executeTransaction(async function () {
                        // @ts-ignore - Zotero types
                        await collectionToAddTo.addItem(newItem.id);
                     });
                 }
            }

            // Select the item
            if (result.zotero_key) {
                 const newItem = await Zotero.Items.getByLibraryAndKeyAsync(result.library_id, result.zotero_key);
                 if (newItem) {
                     await selectItem(newItem);
                 }
            }

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
    }, [ackProposedActions, messageId, note.id, note.content, note.isComplete, noteAction, noteTitle, trimmedContent, setProposedActionsToError, setNotePanelState]);

    // Determine when content can be toggled
    const canToggleContent = note.isComplete;
    const hasContent = trimmedContent.length > 0;
    
    // Current library check for read-only state in UI
    const currentLib = getCurrentLibrary();
    const isReadOnly = currentLib ? !isLibraryEditable(currentLib.id) : true;

    return (
        <div
            className="border-popup rounded-md display-flex flex-col min-w-0"
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
                handleCopy={handleCopy}
                revealNote={revealNote}
                isLibraryReadOnly={isReadOnly}
            />
            <NoteBody
                trimmedContent={trimmedContent}
                contentVisible={contentVisible}
                hasContent={hasContent}
                toggleContent={toggleContent}
                exportRendering={exportRendering}
            />
        </div>
    );
};

export default NoteDisplay;