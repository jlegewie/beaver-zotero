import React, { useCallback, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { getCurrentLibrary, isLibraryEditable, getZoteroTargetContext } from '../../../src/utils/zoteroUtils';
import { citationDataMapAtom } from '../../atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../atoms/externalReferences';
import IconButton from '../ui/IconButton';
import {
    ArrowDownIcon,
    ArrowRightIcon,
    CopyIcon,
    Icon,
    Spinner,
    PlusSignIcon,
    TickIcon
} from '../icons/icons';
import MarkdownRenderer from './MarkdownRenderer';
import {
    getAgentActionByIdAtom,
    getAgentNoteActionByRawTagAtom,
    ackAgentActionsAtom,
    setAgentActionsToErrorAtom,
    isZoteroNoteAgentAction,
} from '../../agents/agentActions';
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
import { selectItemById } from '../../../src/utils/selectItem';
import { ToolDisplayFooter } from './ToolDisplayFooter';

export interface StreamingNoteBlock {
    id: string;
    title?: string;
    itemId?: string | null;
    attributes: Record<string, string>;
    content: string;
    isComplete: boolean;
    /** Raw tag from LLM output - used for matching when id is not present */
    rawTag?: string;
}

interface NoteDisplayProps {
    note: StreamingNoteBlock;
    /** Agent run ID for matching agent actions */
    runId?: string;
    /** Message ID (legacy - for SSE streaming) */
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
    handleReveal: () => void;
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
        handleReveal
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
            const className = `${props.className || ''} `.trim();
            return <Spinner size={size} className={className} />;
        };
    }, []);

    // Memoize the header icon to prevent recomputation on every render
    const HeaderIcon = useMemo(() => {
        if (isSaving) return SpinnerWrapper;
        if (!isComplete) return SpinnerWrapper;
        if (isTitleHovered && !contentVisible) return ArrowRightIcon;
        if (isTitleHovered && contentVisible) return ArrowDownIcon;
        return () => <ZoteroIcon icon={ZOTERO_ICONS.NOTES} size={12} />;
    }, [isSaving, status, isComplete, isTitleHovered, contentVisible, SpinnerWrapper]);

    const isApplied = status === 'applied';
    const isSaveDisabled = isSaving || !isComplete || isLibraryReadOnly;
    const actionTooltip = isApplied 
            ? "Reveal in Zotero"
            : isLibraryReadOnly 
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
            >
                <div className="mt-015" style={{ justifyContent: 'center' }}>
                    <Icon 
                        icon={HeaderIcon} 
                        className="font-color-secondary" 
                        size={12}
                        aria-label="Toggle content"
                    />
                </div>
                <div
                    className={`
                        text-base truncate font-color-secondary
                        ${!canToggleContent ? 'disabled-but-styled' : ''}
                        ${status === 'error' ? 'font-color-warning' : ''}
                    `}
                    title={noteTitle}
                >
                    {noteTitle}
                </div>
                <div className="flex-1" />
            </div>

            {/* Action buttons */}
            <div className="display-flex flex-row gap-3">
                <Tooltip content={actionTooltip} showArrow singleLine>
                    <IconButton
                        icon={isApplied 
                            ? () => <ZoteroIcon icon={ZOTERO_ICONS.SHOW_ITEM} size={10} />
                            : showSavedState ? TickIcon : PlusSignIcon}
                        className="mt-015"
                        variant="ghost-secondary"
                        onClick={isApplied ? handleReveal : handleSaveClick}
                        disabled={isApplied ? false : isSaveDisabled}
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
            <ToolDisplayFooter toggleContent={toggleContent} />
        </div>
    );
});


const NoteDisplay: React.FC<NoteDisplayProps> = ({ note, runId, messageId, exportRendering = false }) => {
    // Agent actions
    const getAgentActionById = useAtomValue(getAgentActionByIdAtom);
    const getAgentNoteActionByRawTag = useAtomValue(getAgentNoteActionByRawTagAtom);
    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const setAgentActionsToError = useSetAtom(setAgentActionsToErrorAtom);

    const citationDataMap = useAtomValue(citationDataMapAtom);
    const externalMapping = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferencesMap = useAtomValue(externalReferenceMappingAtom);

    // UI state for collapsible note panel - use id if available, otherwise use rawTag
    const panelKey = note.id || note.rawTag || `note-${note.title}`;
    const panelStates = useAtomValue(notePanelStateAtom);
    const panelState = panelStates[panelKey] ?? defaultNotePanelState;
    const { contentVisible, isSaving } = panelState;

    const setNotePanelState = useSetAtom(setNotePanelStateAtom);
    const toggleNotePanelVisibility = useSetAtom(toggleNotePanelVisibilityAtom);

    // Get the agent action for this note
    // Strategy: try id match first, then fallback to raw_tag match
    const noteAction = useMemo(() => {
        // Try id match first (for historical data with injected IDs)
        if (note.id) {
            const actionById = getAgentActionById(note.id);
            if (actionById && isZoteroNoteAgentAction(actionById)) {
                return actionById;
            }
        }
        
        // Fallback to raw_tag match (for streaming or unprocessed content)
        if (runId && note.rawTag) {
            const actionByRawTag = getAgentNoteActionByRawTag(runId, note.rawTag);
            if (actionByRawTag && isZoteroNoteAgentAction(actionByRawTag)) {
                return actionByRawTag;
            }
        }
        
        return null;
    }, [note.id, note.rawTag, runId, getAgentActionById, getAgentNoteActionByRawTag]);

    const status: NoteStatus = noteAction ? noteAction.status : 'missing';

    const noteTitle = note.title || noteAction?.proposed_data?.title || 'New note';
    const trimmedContent = note.content.replace(/^\n+/, '');

    // Toggle visibility of note content
    const toggleContent = useCallback(() => {
        toggleNotePanelVisibility(panelKey);
    }, [panelKey, toggleNotePanelVisibility]);

    const handleCopy = useCallback(async () => {
        const formattedContent = renderToMarkdown(`# ${noteTitle}\n\n${trimmedContent || note.content}`);
        await copyToClipboard(formattedContent);
    }, [noteTitle, trimmedContent, note.content]);

    const handleReveal = useCallback(async () => {
        if (noteAction?.result_data?.library_id && noteAction?.result_data?.zotero_key) {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(noteAction.result_data.library_id, noteAction.result_data.zotero_key);
            if (item) {
                await selectItemById(item.id);
            }
        }
    }, [noteAction]);

    const handleSave = useCallback(async () => {
        if (!noteAction || !note.isComplete) {
            return;
        }
        
        setNotePanelState({ key: panelKey, updates: { isSaving: true } });
        try {
            const { targetLibraryId, parentReference, collectionToAddTo } = await getZoteroTargetContext();

            if (!targetLibraryId) {
                throw new Error("Could not determine target library");
            }
            
            if (!isLibraryEditable(targetLibraryId)) {
                throw new Error("Library is read-only");
            }

            const noteContent = `<h1>${noteTitle}</h1>\n\n${trimmedContent || note.content}`;
            const result = await saveStreamingNote({
                markdownContent: noteContent,
                title: noteTitle,
                parentReference: parentReference || undefined,
                targetLibraryId: targetLibraryId,
                contextData: { citationDataMap, externalMapping, externalReferencesMap }
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
                     await selectItemById(newItem.id);
                 }
            }

            // Update agent action state (UI + backend)
            if (runId) {
                ackAgentActions(runId, [{ action_id: noteAction.id, result_data: result }]);
            }
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to save note';
            setAgentActionsToError([noteAction.id], errorMessage, {
                stack_trace: error?.stack || '',
                error_name: error?.name,
            });
        } finally {
            setNotePanelState({ key: panelKey, updates: { isSaving: false } });
        }
    }, [ackAgentActions, runId, panelKey, note.content, note.isComplete, noteAction, noteTitle, trimmedContent, setAgentActionsToError, setNotePanelState, citationDataMap, externalMapping, externalReferencesMap]);

    // Determine when content can be toggled
    const canToggleContent = note.isComplete;
    const hasContent = trimmedContent.length > 0;
    
    // Current library check for read-only state in UI
    const currentLib = getCurrentLibrary();
    const isReadOnly = currentLib ? !isLibraryEditable(currentLib.libraryID) : true;

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
                handleReveal={handleReveal}
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
