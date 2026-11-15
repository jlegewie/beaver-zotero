import React, { useState } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import type { FeatureCreditPopupData } from '../../types/popupMessage';
import { ArrowRightIcon, CancelIcon, CheckmarkCircleSolidIcon, Icon } from '../icons/icons';
import { featureCreditEntriesAtom, featureCreditTotalsAtom, startFeatureTaskAtom } from '../../atoms/featureCredits';
import { newThreadAtom } from '../../atoms/threads';
import { getFeatureCreditTask } from '../../constants/featureCreditTasks';
import { actionsAtom, importActionAtom } from '../../atoms/actions';
import { openPreferencesWindow } from '../../ui/openPreferencesWindow';
import { threadAgentActionsAtom } from '../../agents/agentActions';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { useFileExport } from '../../hooks/useFileExport';
import { exportNoteToFile } from '../../host/zotero/fileExport';
import { getCreatedNoteExportTarget } from '../../host/zotero/components/reviewChangeRows';
import { countPendingNoteEdits } from '../../host/zotero/components/reviewChanges/useRunActionRows';

/** The note a run wrote (its last `create_note`), when the run wrote one. */
function createdNoteOfRun(actions: AgentAction[], runId: string): AgentAction | null {
    for (let index = actions.length - 1; index >= 0; index--) {
        const action = actions[index];
        if (action.run_id === runId && action.action_type === 'create_note' && action.toolcall_id) return action;
    }
    return null;
}

interface Props {
    data: FeatureCreditPopupData;
    onDismiss: () => void;
}

/**
 * The card a window shows when a run started from a feature-credit setup card
 * ends. Every task has the same three parts: the reward, one tip on what else
 * the skill can do (ending in one link: exporting the note the run wrote, a
 * starter action of the user's own, or the docs), and the next task (or the
 * total once all are done). What Beaver did is already in the chat above. It
 * stays until closed.
 */
const FeatureCreditCompletionContent: React.FC<Props> = ({ data, onDismiss }) => {
    const definition = getFeatureCreditTask(data.key);
    const entries = useAtomValue(featureCreditEntriesAtom) ?? [];
    const totals = useAtomValue(featureCreditTotalsAtom);
    const startTask = useSetAtom(startFeatureTaskAtom);
    const newThread = useSetAtom(newThreadAtom);
    const actions = useAtomValue(actionsAtom);
    const importAction = useSetAtom(importActionAtom);
    // The action this card created, so a second click edits it again
    // instead of adding another copy.
    const [createdActionId, setCreatedActionId] = useState<string | null>(null);
    const jotaiStore = useStore();
    const { exporting, run: runExport } = useFileExport();
    const threadActions = useAtomValue(threadAgentActionsAtom);

    if (!definition) return null;

    const next = entries.find((entry) => !entry.task.completed_at && entry.definition.key !== data.key);
    const { docsUrl, tip, customAction, exportNote } = definition.completion;
    // Only while the chat that wrote the note is open: its actions are this
    // window's thread's.
    const noteAction = exportNote ? createdNoteOfRun(threadActions, data.runId) : null;

    const exportCreatedNote = async () => {
        // Read at click time: the note may have been applied since the card showed.
        const action = createdNoteOfRun(jotaiStore.get(threadAgentActionsAtom), data.runId);
        const toolCallId = action?.toolcall_id;
        if (!action || !toolCallId) return;
        const note = getCreatedNoteExportTarget(action);
        await runExport('docx', () => exportNoteToFile({
            format: 'docx',
            surface: 'note_card',
            note,
            createdBy: { runId: action.run_id, toolCallId },
            pendingChanges: note ? countPendingNoteEdits(jotaiStore, note) : 0,
        }));
    };

    const createCustomAction = () => {
        if (!customAction) return;
        let actionId = createdActionId && actions.some((action) => action.id === createdActionId) ? createdActionId : null;
        if (!actionId) {
            // The import path mints the id and a free /command.
            actionId = importAction({ id: '', ...customAction.template }).action.id;
            setCreatedActionId(actionId);
        }
        openPreferencesWindow('actions', undefined, actionId);
    };

    const startNext = async (event: React.MouseEvent<HTMLButtonElement>) => {
        if (!next) return;
        const key = next.definition.key;
        const win = event.currentTarget.ownerDocument?.defaultView ?? undefined;
        // Undefined when the user kept the current chat, or another
        // navigation superseded this one.
        if ((await newThread({ window: win })) === undefined) return;
        onDismiss();
        startTask({ key, targetWindow: win });
    };

    return (
        <div className="feature-credits-completion">
            <div className="feature-credits-header feature-credits-completion-header">
                <Icon icon={CheckmarkCircleSolidIcon} className="feature-credits-completion-mark font-color-green" />
                <div className="feature-credits-completion-heading">
                    <h2 className="feature-credits-title">You got {data.credits} credits</h2>
                    <span className="feature-credits-completion-subtitle">
                        {definition.title}
                    </span>
                </div>
                <IconButton icon={CancelIcon} variant="ghost-secondary" ariaLabel="Close" onClick={onDismiss} />
            </div>

            <p className="feature-credits-text">
                {tip}{' '}
                {exportNote && noteAction ? (
                    <a
                        href="#"
                        className="feature-credits-link"
                        aria-disabled={exporting}
                        onClick={(event) => {
                            event.preventDefault();
                            void exportCreatedNote();
                        }}
                    >
                        {exportNote.label}
                    </a>
                ) : customAction ? (
                    <a
                        href="#"
                        className="feature-credits-link"
                        onClick={(event) => {
                            event.preventDefault();
                            createCustomAction();
                        }}
                    >
                        {customAction.label}
                    </a>
                ) : (
                    <a
                        href={docsUrl}
                        className="feature-credits-link"
                        onClick={(event) => {
                            event.preventDefault();
                            Zotero.launchURL(docsUrl);
                        }}
                    >
                        Learn more
                    </a>
                )}
            </p>

            <div className="feature-credits-divider" />
            {next ? (
                <button type="button" className="feature-credits-next" onClick={(event) => void startNext(event)}>
                    <span className="flex-1">Next: {next.definition.title}</span>
                    <Icon icon={ArrowRightIcon} className="font-color-secondary" />
                </button>
            ) : (
                <p className="feature-credits-text">All done. You got {totals.earned} credits.</p>
            )}
        </div>
    );
};

export default FeatureCreditCompletionContent;
