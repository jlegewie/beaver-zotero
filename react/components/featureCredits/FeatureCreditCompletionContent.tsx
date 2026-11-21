import React, { useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import type { PendingFeatureCredit } from '../../atoms/featureCreditRuns';
import { ArrowRightIcon, CancelIcon, CheckmarkCircleSolidIcon, DownloadIcon, Icon } from '../icons/icons';
import { featureCreditEntriesAtom, featureCreditTotalsAtom, startFeatureTaskAtom } from '../../atoms/featureCredits';
import { newThreadAtom } from '../../atoms/threads';
import { getFeatureCreditTask } from '../../constants/featureCreditTasks';
import { actionsAtom, importActionAtom } from '../../atoms/actions';
import { openPreferencesWindow } from '../../ui/openPreferencesWindow';
import { agentActionsForRunsAtom } from '../../agents/agentActions';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import type { AgentRun } from '@beaver/agent-core/agents/types';

/** Whether the answer's last `create_note` is now in the library. */
function noteInLibrary(actions: readonly AgentAction[]): boolean {
    for (let index = actions.length - 1; index >= 0; index--) {
        const action = actions[index];
        if (action.action_type === 'create_note') return action.status === 'applied';
    }
    return false;
}

interface Props {
    data: PendingFeatureCredit;
    /** The answer's run chain: a continuation may write the note. */
    runs: readonly AgentRun[];
    onDismiss: () => void;
}

/**
 * The card under a run started from a feature-credit setup card, once the run
 * ends. Every task has the same three parts: the reward, one tip on what else
 * the skill can do (ending in one link: a starter action of the user's own, or
 * the docs; or, once the note the run wrote is in the library, pointing to its
 * card's export), and the next task (or the total once all are done). What
 * Beaver did is in the chat above. It stays until closed.
 */
const FeatureCreditCompletionContent: React.FC<Props> = ({ data, runs, onDismiss }) => {
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
    const actionsByRun = useAtomValue(useMemo(() => agentActionsForRunsAtom(runs.map((run) => run.id)), [runs]));

    if (!definition) return null;

    const next = entries.find((entry) => !entry.task.completed_at && entry.definition.key !== data.key);
    const { docsUrl, tip, customAction, noteTip } = definition.completion;
    // Updates when the user creates a proposed note.
    const showNoteTip = !!noteTip && noteInLibrary(actionsByRun.flat());

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
        <div className="feature-credits-card feature-credits-completion">
            <div className="feature-credits-header">
                <Icon icon={CheckmarkCircleSolidIcon} className="font-color-green" />
                <h2 className="feature-credits-completion-title">You got {data.credits} credits</h2>
                <IconButton icon={CancelIcon} variant="ghost-secondary" ariaLabel="Close" onClick={onDismiss} />
            </div>

            <div className="feature-credits-completion-body">
                {showNoteTip ? (
                    <p className="feature-credits-text">
                        {noteTip}{' '}
                        <Icon icon={DownloadIcon} className="feature-credits-inline-icon font-color-secondary" role="img" aria-label="Export" />.
                    </p>
                ) : (
                    <p className="feature-credits-text">
                        {tip}{' '}
                        {customAction ? (
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
                )}

                {next ? (
                    <button type="button" className="feature-credits-next" onClick={(event) => void startNext(event)}>
                        <span>Next: {next.definition.title}</span>
                        <Icon icon={ArrowRightIcon} className="font-color-secondary" />
                    </button>
                ) : (
                    <p className="feature-credits-text font-color-secondary">All done. You got {totals.earned} credits.</p>
                )}
            </div>
        </div>
    );
};

export default FeatureCreditCompletionContent;
