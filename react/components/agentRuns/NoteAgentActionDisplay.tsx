import React, { useCallback, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    AgentAction,
    ackAgentActionsAtom,
    rejectAgentActionAtom,
    undoAgentActionAtom,
    isCreateNoteAgentAction,
} from '../../agents/agentActions';
import { NoteProposedData } from '../../types/agentActions/base';
import { AgentRun } from '../../agents/types';
import { ZoteroItemReference } from '../../types/zotero';
import { ZOTERO_ICONS, ZoteroIcon } from '../icons/ZoteroIcon';
import {
    TickIcon,
    NoteIcon,
    CancelIcon,
    ArrowUpRightIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    Icon,
    Spinner,
    CheckmarkCircleIcon,
    DeleteIcon,
} from '../icons/icons';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import { selectItemById } from '../../../src/utils/selectItem';
import { isLibraryEditable } from '../../../src/utils/zoteroUtils';
import { saveStreamingNote } from '../../utils/noteActions';
import {
    extractNoteBlocksFromMessages,
    isNoteAutoApplied,
    clearNoteAutoApplied,
    noteTagsMatch,
    ParsedNoteBlock,
} from '../../utils/agentActionUtils';
import { citationDataMapAtom } from '../../atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../atoms/externalReferences';
import { isLibraryTabAtom } from '../../atoms/ui';
import { logger } from '../../../src/utils/logger';
import Button from '../ui/Button';

interface NoteAgentActionRowProps {
    action: AgentAction;
    runId: string;
    noteBlocks: ParsedNoteBlock[];
    /** When true, the row is rendered inside a grouped container — outer
     * border, rounding and the header background are handled by the parent. */
    inGroup?: boolean;
}

const NoteAgentActionRow: React.FC<NoteAgentActionRowProps> = ({ action, runId, noteBlocks, inGroup = false }) => {
    const [isBusy, setIsBusy] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);

    const citationDataMap = useAtomValue(citationDataMapAtom);
    const externalMapping = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferencesMap = useAtomValue(externalReferenceMappingAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);

    const proposed = action.proposed_data as NoteProposedData;
    const title = proposed?.title || 'New note';
    const isApplied = action.status === 'applied';
    const isPending = action.status === 'pending' || action.status === 'error';
    const actionLabel = isApplied ? 'Created Note' : 'Create Note';

    // Reveal note in Zotero
    const handleReveal = useCallback(async () => {
        if (action.result_data?.library_id && action.result_data?.zotero_key) {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(
                action.result_data.library_id, action.result_data.zotero_key
            );
            if (item) await selectItemById(item.id);
        }
    }, [action.result_data]);

    // Undo: delete note from Zotero + revert action status
    const handleUndo = useCallback(async () => {
        if (isBusy) return;
        setIsBusy(true);
        try {
            if (action.result_data?.library_id && action.result_data?.zotero_key) {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(
                    action.result_data.library_id, action.result_data.zotero_key
                );
                if (item) await item.eraseTx();
            }
            clearNoteAutoApplied(action.id);
            undoAgentAction(action.id);
        } catch (err) {
            logger(`NoteAgentActionRow: Undo failed: ${err}`, 1);
        } finally {
            setIsBusy(false);
        }
    }, [action, isBusy, undoAgentAction]);

    // Confirm: create note in Zotero and ack the action
    const handleConfirm = useCallback(async () => {
        if (isBusy) return;
        setIsBusy(true);
        try {
            const actionRawTag = proposed.raw_tag;
            const matchedBlock = actionRawTag
                ? noteBlocks.find(b => noteTagsMatch(b.rawTag, actionRawTag))
                : null;

            if (!matchedBlock || !matchedBlock.content.trim()) {
                logger('NoteAgentActionRow: No content found for note action', 1);
                return;
            }

            const content = matchedBlock.content;
            let parentReference: ZoteroItemReference | undefined;
            let targetLibraryId: number | undefined;

            if (proposed.library_id != null && proposed.zotero_key) {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(
                    proposed.library_id, proposed.zotero_key
                );
                if (item) {
                    targetLibraryId = proposed.library_id;
                    if (item.isAttachment() && item.parentKey) {
                        parentReference = { library_id: proposed.library_id, zotero_key: item.parentKey };
                    } else {
                        parentReference = { library_id: proposed.library_id, zotero_key: proposed.zotero_key };
                    }
                }
            }

            // Fall back to user's personal library for standalone notes
            if (!targetLibraryId) {
                targetLibraryId = Zotero.Libraries.userLibraryID;
            }

            if (!isLibraryEditable(targetLibraryId)) {
                logger('NoteAgentActionRow: Target library is not editable, rejecting action', 1);
                rejectAgentAction(action.id);
                return;
            }

            const noteContent = `<h1>${title}</h1>\n\n${content}`;
            const result = await saveStreamingNote({
                markdownContent: noteContent,
                title,
                parentReference,
                targetLibraryId,
                contextData: { citationDataMap, externalMapping, externalReferencesMap },
            });

            await ackAgentActions(runId, [{ action_id: action.id, result_data: result }]);

            // Reveal the created note in Zotero when in library view
            if (isLibraryTab && result.library_id && result.zotero_key) {
                const noteItem = await Zotero.Items.getByLibraryAndKeyAsync(
                    result.library_id, result.zotero_key
                );
                if (noteItem) await selectItemById(noteItem.id);
            }
        } catch (err: any) {
            logger(`NoteAgentActionRow: Confirm failed: ${err.message}`, 1);
        } finally {
            setIsBusy(false);
        }
    }, [action, isBusy, noteBlocks, proposed, title, runId, ackAgentActions, rejectAgentAction, isLibraryTab, citationDataMap, externalMapping, externalReferencesMap]);

    // Dismiss: reject the action
    const handleDismiss = useCallback(() => {
        clearNoteAutoApplied(action.id);
        rejectAgentAction(action.id);
    }, [action.id, rejectAgentAction]);

    // Create a wrapper for Spinner that converts width/height props to size
    const SpinnerWrapper = useMemo(() => {
        return (props: React.SVGProps<SVGSVGElement>) => {
            const size = typeof props.width === 'number' ? props.width :
                typeof props.width === 'string' && props.width !== '1em'
                    ? parseInt(props.width) || 12 : 12;
            return <Spinner size={size} className={props.className} />;
        };
    }, []);

    const getHeaderIcon = () => {
        if (isBusy) return SpinnerWrapper;
        if (isApplied) return inGroup ? NoteIcon : CheckmarkCircleIcon;
        return () => <ZoteroIcon icon={ZOTERO_ICONS.NOTES} size={12} className="mt-010"/>;
    };

    const getIconClassName = () => {
        if (isApplied) return inGroup ? 'font-color-secondary scale-11' : 'font-color-green scale-11';
        return undefined;
    };

    const containerClassName = inGroup
        ? 'display-flex flex-col min-w-0'
        : 'border-popup rounded-md display-flex flex-col min-w-0';
    const innerRowClassName = inGroup
        ? 'display-flex flex-row items-start py-15 gap-1'
        : 'display-flex flex-row bg-senary items-start py-15 gap-1';

    return (
        <div className={containerClassName}>
            <div className={innerRowClassName}>
                {/* Icon + label + title (clickable to reveal when applied) */}
                <div
                    className={`display-flex flex-row ml-3 gap-2 min-w-0 ${isApplied ? 'cursor-pointer' : ''}`}
                    onMouseEnter={() => isApplied && setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                    onClick={isApplied ? handleReveal : undefined}
                >
                    <div className="display-flex mt-015" style={{ flexShrink: 0 }}>
                        <Icon icon={getHeaderIcon()} className={getIconClassName()} />
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
                        {!inGroup && (
                            <span className="font-color-primary font-medium">{actionLabel}</span>
                        )}
                        <span
                            className={`${!inGroup ? 'ml-15' : ''} ${isHovered ? 'font-color-primary' : 'font-color-secondary'}`}
                            style={{ transition: 'color 0.15s ease' }}
                        >
                            {title}
                        </span>
                        {isApplied && (
                            <span className="font-color-secondary scale-10" style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'pointer', marginLeft: '1px' }}>
                                <Icon icon={ArrowUpRightIcon} />
                            </span>
                        )}
                    </div>
                </div>

                <div className="flex-1" />

                {/* Action buttons */}
                <div className={`display-flex flex-row items-center gap-1 ${isApplied ? 'mr-2' : 'mr-3 mt-020'}`}>
                    {isApplied && (
                        <>
                            <Tooltip content="Delete note" showArrow singleLine>
                                <IconButton
                                    icon={DeleteIcon}
                                    variant="ghost-secondary"
                                    onClick={handleUndo}
                                    disabled={isBusy}
                                    className="scale-90 mt-020"
                                />
                            </Tooltip>
                            <Tooltip content="Dismiss" showArrow singleLine>
                                <IconButton
                                    icon={CancelIcon}
                                    variant="ghost-secondary"
                                    onClick={handleDismiss}
                                    disabled={isBusy}
                                    className="scale-80 mt-020"
                                />
                            </Tooltip>
                        </>
                    )}
                    {isPending && (
                        <>
                            <Tooltip content="Dismiss" showArrow singleLine>
                                <IconButton
                                    icon={CancelIcon}
                                    variant="ghost-secondary"
                                    iconClassName="font-color-red"
                                    onClick={handleDismiss}
                                    disabled={isBusy}
                                />
                            </Tooltip>
                            <Tooltip content="Create note" showArrow singleLine>
                                <IconButton
                                    icon={TickIcon}
                                    variant="ghost-secondary"
                                    iconClassName="font-color-green scale-14"
                                    onClick={handleConfirm}
                                    disabled={isBusy}
                                />
                            </Tooltip>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

interface NoteAgentActionGroupProps {
    runId: string;
    actions: AgentAction[];
    noteBlocks: ParsedNoteBlock[];
}

/**
 * Grouped container that consolidates multiple note actions into a single
 * collapsible card. Mirrors the layout of EditNoteGroupView so note-creation
 * UI stays visually consistent with note-edit UI when more than one action
 * is shown.
 */
const NoteAgentActionGroup: React.FC<NoteAgentActionGroupProps> = ({ runId, actions, noteBlocks }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [clickedButton, setClickedButton] = useState<'undo' | 'dismiss' | null>(null);

    const undoAgentAction = useSetAtom(undoAgentActionAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);

    const appliedCount = actions.filter(a => a.status === 'applied').length;
    const allApplied = appliedCount === actions.length;
    const groupLabel = `Created ${actions.length} Notes`;

    const headerIcon = (() => {
        if (isProcessing) return Spinner;
        if (isHovered && isExpanded) return ArrowDownIcon;
        if (isHovered && !isExpanded) return ArrowRightIcon;
        if (allApplied) return CheckmarkCircleIcon;
        return () => <ZoteroIcon icon={ZOTERO_ICONS.NOTES} size={12} className="mt-010"/>;
    })();
    const headerIconClassName = !isProcessing && !isHovered && allApplied
        ? 'font-color-green scale-11'
        : undefined;

    const toggleExpanded = useCallback(() => {
        if (isProcessing) return;
        setIsExpanded(prev => !prev);
    }, [isProcessing]);

    const handleUndoAll = useCallback(async () => {
        if (isProcessing) return;
        const appliedActions = actions.filter(a => a.status === 'applied');
        if (appliedActions.length === 0) return;

        setIsProcessing(true);
        setClickedButton('undo');
        try {
            for (const action of appliedActions) {
                try {
                    if (action.result_data?.library_id && action.result_data?.zotero_key) {
                        const item = await Zotero.Items.getByLibraryAndKeyAsync(
                            action.result_data.library_id, action.result_data.zotero_key
                        );
                        if (item) await item.eraseTx();
                    }
                    clearNoteAutoApplied(action.id);
                    undoAgentAction(action.id);
                } catch (err) {
                    logger(`NoteAgentActionGroup: Undo failed for ${action.id}: ${err}`, 1);
                }
            }
        } finally {
            setIsProcessing(false);
            setClickedButton(null);
        }
    }, [actions, isProcessing, undoAgentAction]);

    const handleDismissAll = useCallback(() => {
        if (isProcessing) return;
        setClickedButton('dismiss');
        for (const action of actions) {
            clearNoteAutoApplied(action.id);
            rejectAgentAction(action.id);
        }
        setTimeout(() => setClickedButton(null), 100);
    }, [actions, isProcessing, rejectAgentAction]);

    const showHeaderActions = !isExpanded && !isProcessing;
    const showFooterActions = isExpanded;

    return (
        <div className="border-popup rounded-md display-flex flex-col min-w-0">
            <div
                className={`display-flex flex-row py-15 bg-senary items-start ${isExpanded ? 'border-bottom-quinary' : ''}`}
            >
                <button
                    type="button"
                    className="variant-ghost-secondary display-flex flex-row py-15 gap-2 text-left mt-015"
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={isExpanded}
                    onClick={toggleExpanded}
                    disabled={isProcessing}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <div className="display-flex flex-row ml-3 gap-2">
                        <div className="flex-1 display-flex mt-010 font-color-primary">
                            <Icon icon={headerIcon} className={headerIconClassName} />
                        </div>
                        <div className="display-flex">
                            <span className="font-color-primary font-medium">{groupLabel}</span>
                        </div>
                    </div>
                </button>

                <div className="flex-1" />

                {showHeaderActions && (
                    <div className="display-flex flex-row items-center gap-25 mr-3 mt-015">
                        <Tooltip content="Dismiss" showArrow singleLine>
                            <IconButton
                                icon={CancelIcon}
                                variant="ghost-secondary"
                                // iconClassName="font-color-secondary"
                                onClick={handleDismissAll}
                                disabled={isProcessing}
                            />
                        </Tooltip>
                    </div>
                )}
            </div>

            {isExpanded && (
                <div className="display-flex flex-col">
                    <div className="display-flex flex-col">
                        {actions.map((action, idx) => (
                            <div
                                key={action.id}
                                className={idx > 0 ? 'border-top-quinary' : undefined}
                            >
                                <NoteAgentActionRow
                                    action={action}
                                    runId={runId}
                                    noteBlocks={noteBlocks}
                                    inGroup
                                />
                            </div>
                        ))}
                    </div>

                    {showFooterActions && (
                        <div className="display-flex flex-row gap-2 px-2 py-2">
                            <div className="flex-1" />
                            <Button
                                variant="outline"
                                onClick={handleDismissAll}
                                disabled={isProcessing}
                                loading={isProcessing && clickedButton === 'dismiss'}
                            >
                                Dismiss
                            </Button>
                            {appliedCount > 0 && (
                                <Button
                                    variant="outline"
                                    onClick={handleUndoAll}
                                    disabled={isProcessing}
                                    loading={isProcessing && clickedButton === 'undo'}
                                >
                                    Delete All
                                </Button>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

interface NoteAgentActionDisplayProps {
    run: AgentRun;
    actions: AgentAction[];
}

/**
 * Displays auto-created or pending note agent actions.
 *
 * Single note: rendered as a standalone row (icon + title + per-row actions).
 * Multiple notes: rendered as a single grouped, collapsible card with a
 * summary header ("Created N Notes"), expandable per-note rows, and a
 * footer with "Dismiss All" / "Undo All" actions — matching the visual
 * pattern of EditNoteGroupView.
 */
const NoteAgentActionDisplay: React.FC<NoteAgentActionDisplayProps> = ({ run, actions }) => {
    // Show pending/error (awaiting user confirmation) and auto-applied notes (allowing undo).
    // Auto-applied notes are tracked in a session-only set — they don't reappear on reload.
    // Manually confirmed notes become 'applied' but aren't in the auto-applied set, so they disappear.
    const visibleActions = actions.filter(a =>
        // FOR NOW: Only show for auto-applied notes
        // a.status === 'pending' || a.status === 'error' || (a.status === 'applied' && isNoteAutoApplied(a.id))
        (a.status === 'applied' && isNoteAutoApplied(a.id)) ||
        (a.status === 'applied' && isCreateNoteAgentAction(a))
    );

    // Pre-extract note blocks from run messages for content matching
    const noteBlocks = useMemo(() =>
        extractNoteBlocksFromMessages(run.model_messages),
        [run.model_messages]
    );

    if (visibleActions.length === 0) return null;

    if (visibleActions.length === 1) {
        return (
            <NoteAgentActionRow
                action={visibleActions[0]}
                runId={run.id}
                noteBlocks={noteBlocks}
            />
        );
    }

    return (
        <NoteAgentActionGroup
            runId={run.id}
            actions={visibleActions}
            noteBlocks={noteBlocks}
        />
    );
};

export default NoteAgentActionDisplay;
