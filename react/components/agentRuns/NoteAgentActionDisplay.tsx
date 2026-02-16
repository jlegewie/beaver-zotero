import React, { useCallback, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    AgentAction,
    ackAgentActionsAtom,
    rejectAgentActionAtom,
    undoAgentActionAtom,
} from '../../agents/agentActions';
import { NoteProposedData } from '../../types/agentActions/base';
import { AgentRun } from '../../agents/types';
import { ZoteroItemReference } from '../../types/zotero';
import { ZOTERO_ICONS, ZoteroIcon } from '../icons/ZoteroIcon';
import { TickIcon, CancelIcon, Icon, Spinner } from '../icons/icons';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import { selectItemById } from '../../../src/utils/selectItem';
import { isLibraryEditable } from '../../../src/utils/zoteroUtils';
import { saveStreamingNote } from '../../utils/noteActions';
import {
    extractNoteBlocksFromMessages,
    noteTagsMatch,
    ParsedNoteBlock,
} from '../../utils/agentActionUtils';
import { citationDataMapAtom } from '../../atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../atoms/externalReferences';
import { logger } from '../../../src/utils/logger';

interface NoteAgentActionRowProps {
    action: AgentAction;
    runId: string;
    noteBlocks: ParsedNoteBlock[];
}

const NoteAgentActionRow: React.FC<NoteAgentActionRowProps> = ({ action, runId, noteBlocks }) => {
    const [isBusy, setIsBusy] = useState(false);
    const ackAgentActions = useSetAtom(ackAgentActionsAtom);
    const rejectAgentAction = useSetAtom(rejectAgentActionAtom);
    const undoAgentAction = useSetAtom(undoAgentActionAtom);

    const citationDataMap = useAtomValue(citationDataMapAtom);
    const externalMapping = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferencesMap = useAtomValue(externalReferenceMappingAtom);

    const proposed = action.proposed_data as NoteProposedData;
    const title = proposed?.title || 'New note';
    const isApplied = action.status === 'applied';
    const isPending = action.status === 'pending' || action.status === 'error';

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

            if (!targetLibraryId || !isLibraryEditable(targetLibraryId)) {
                logger('NoteAgentActionRow: No valid editable target library', 1);
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
        } catch (err: any) {
            logger(`NoteAgentActionRow: Confirm failed: ${err.message}`, 1);
        } finally {
            setIsBusy(false);
        }
    }, [action, isBusy, noteBlocks, proposed, title, runId, ackAgentActions, citationDataMap, externalMapping, externalReferencesMap]);

    // Dismiss: reject the action
    const handleDismiss = useCallback(() => {
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

    return (
        <div className="border-popup rounded-md display-flex flex-col min-w-0">
            <div className="display-flex flex-row bg-senary items-start py-15 px-25">
                {/* Icon */}
                <div className="display-flex flex-row flex-1 gap-25 items-start min-w-0">
                    <div className="mt-015" style={{ justifyContent: 'center' }}>
                        <Icon
                            icon={isBusy
                                ? SpinnerWrapper
                                : () => <ZoteroIcon icon={ZOTERO_ICONS.NOTES} size={12} />
                            }
                            className="font-color-secondary"
                            size={12}
                        />
                    </div>
                    {/* Title — clickable to reveal in Zotero when applied */}
                    <div
                        className={`text-base truncate font-color-secondary ${isApplied ? 'cursor-pointer' : ''}`}
                        title={title}
                        onClick={isApplied ? handleReveal : undefined}
                    >
                        {title}
                    </div>
                    <div className="flex-1" />
                </div>

                {/* Action buttons */}
                <div className="display-flex flex-row gap-3">
                    {isApplied && (
                        <>
                            <Tooltip content="Reveal in Zotero" showArrow singleLine>
                                <IconButton
                                    icon={() => <ZoteroIcon icon={ZOTERO_ICONS.SHOW_ITEM} size={10} />}
                                    className="mt-015"
                                    variant="ghost-secondary"
                                    onClick={handleReveal}
                                />
                            </Tooltip>
                            <Tooltip content="Undo" showArrow singleLine>
                                <IconButton
                                    icon={CancelIcon}
                                    className="mt-015"
                                    variant="ghost-secondary"
                                    onClick={handleUndo}
                                    disabled={isBusy}
                                />
                            </Tooltip>
                        </>
                    )}
                    {isPending && (
                        <>
                            <Tooltip content="Dismiss" showArrow singleLine>
                                <IconButton
                                    icon={CancelIcon}
                                    className="mt-015"
                                    variant="ghost-secondary"
                                    onClick={handleDismiss}
                                    disabled={isBusy}
                                />
                            </Tooltip>
                            <Tooltip content="Create note" showArrow singleLine>
                                <IconButton
                                    icon={TickIcon}
                                    className="mt-015"
                                    variant="ghost-secondary"
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

interface NoteAgentActionDisplayProps {
    run: AgentRun;
    actions: AgentAction[];
}

/**
 * Displays auto-created or pending note agent actions in a compact row format.
 * Each note is a non-expandable row styled like a collapsed NoteDisplay:
 *   [NoteIcon] Title [Action buttons]
 *
 * Applied notes show Reveal + Undo buttons.
 * Pending notes show Dismiss + Confirm buttons.
 */
const NoteAgentActionDisplay: React.FC<NoteAgentActionDisplayProps> = ({ run, actions }) => {
    // Filter to visible note actions (not rejected/undone)
    const visibleActions = actions.filter(a =>
        a.status !== 'rejected' && a.status !== 'undone'
    );

    // Pre-extract note blocks from run messages for content matching
    const noteBlocks = useMemo(() =>
        extractNoteBlocksFromMessages(run.model_messages),
        [run.model_messages]
    );

    if (visibleActions.length === 0) return null;

    return (
        <div className="display-flex flex-col gap-2">
            {visibleActions.map(action => (
                <NoteAgentActionRow
                    key={action.id}
                    action={action}
                    runId={run.id}
                    noteBlocks={noteBlocks}
                />
            ))}
        </div>
    );
};

export default NoteAgentActionDisplay;
