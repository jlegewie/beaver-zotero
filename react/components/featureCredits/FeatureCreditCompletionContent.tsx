import React, { useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { collectTableArtifacts } from '@beaver/agent-core/run-state/tableResults';
import type { CollectionReference } from '@beaver/agent-core/types/zotero';
import { getHost } from '@beaver/agent-ui/host';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import type { PendingFeatureCredit } from '../../atoms/featureCreditRuns';
import { ArrowRightIcon, CancelIcon, CheckmarkCircleSolidIcon, DownloadIcon, Icon } from '../icons/icons';
import { featureCreditEntriesAtom, featureCreditTotalsAtom, startFeatureTaskAtom } from '../../atoms/featureCredits';
import { searchableLibraryIdsAtom } from '../../atoms/profile';
import { newThreadAtom } from '../../atoms/threads';
import { getFeatureCreditTask } from '../../constants/featureCreditTasks';
import { actionsAtom, importActionAtom } from '../../atoms/actions';
import { openPreferencesWindow } from '../../ui/openPreferencesWindow';
import { collectionCandidates, createdHighlights } from '../../utils/featureCredits';
import { getCurrentReader } from '../../utils/readerUtils';
import { collectionToReference } from '../../utils/zoteroReferences';
import { resolveLibraryRef } from '../../../src/utils/libraryIdentity';
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

/**
 * The collection for the next task to work on (see `collectionCandidates`):
 * the first that still exists in a library Beaver may read, or null.
 */
function collectionToCarry(
    runs: readonly AgentRun[],
    actions: readonly AgentAction[],
    searchableLibraryIds: readonly number[],
): CollectionReference | null {
    for (const candidate of collectionCandidates(runs, actions)) {
        const libraryId = resolveLibraryRef(candidate);
        if (!libraryId || !searchableLibraryIds.includes(libraryId)) continue;
        const collection = Zotero.Collections.getByLibraryAndKey(libraryId, candidate.zotero_key);
        if (collection && !collection.deleted) return collectionToReference(collection);
    }
    return null;
}

/** Runs whose highlights were shown: once per run, whenever its card mounts. */
const shownHighlightRuns = new Set<string>();

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
 * the docs; or, pointing at what the run made, the table to open or the
 * export of the note's card), and the next task (or the total once all are
 * done). What Beaver did is in the chat above. It stays until closed.
 *
 * Two things carry the result forward. Highlights the run added to the PDF the
 * user has open are scrolled into view, since they are often pages away. And
 * the next task starts on the collection this one made or worked on, when it
 * is a task that works on a collection.
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
    const runActions = useMemo(() => actionsByRun.flat(), [actionsByRun]);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const tableKey = useMemo(
        () => (definition?.completion.tableTip ? collectTableArtifacts(runs)[0]?.record.reference.key ?? null : null),
        [definition, runs],
    );

    const highlights = useMemo(() => (definition?.attach === 'pdf' ? createdHighlights(runActions) : []), [definition, runActions]);
    useEffect(() => {
        if (highlights.length === 0 || shownHighlightRuns.has(data.runId)) return;
        shownHighlightRuns.add(data.runId);
        // Only in the reader tab the user is looking at, and through that
        // reader itself: never open or switch a tab for it. Read from the tab,
        // since the chat input lets go of its current file while a run is
        // under way.
        const reader = getCurrentReader();
        if (!reader) return;
        // The first highlight in that PDF: the run may have annotated others too.
        const first = highlights.find(({ library_id, zotero_key }) => {
            const annotation = Zotero.Items.getByLibraryAndKey(library_id, zotero_key);
            return !!annotation && annotation.parentItemID === reader.itemID;
        });
        if (first) void Promise.resolve(reader.navigate({ annotationID: first.zotero_key })).catch(() => {});
    }, [highlights, data.runId]);

    if (!definition) return null;

    // The next open task after this one, in the list's order, where tasks that
    // build on each other follow one another; from the last task it wraps
    // around to the first open one.
    const position = entries.findIndex((entry) => entry.definition.key === data.key);
    const next = [...entries.slice(position + 1), ...entries.slice(0, Math.max(position, 0))]
        .find((entry) => !entry.task.completed_at && entry.definition.key !== data.key);
    const { docsUrl, tip, customAction, noteTip, tableTip } = definition.completion;
    // Updates when the user creates a proposed note.
    const showNoteTip = !!noteTip && noteInLibrary(runActions);

    const openTable = (event: React.MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        if (!tableKey) return;
        const origin = event.currentTarget.ownerDocument?.defaultView ?? null;
        // The host tells the user when the table cannot be opened.
        void getHost().navigation?.openTable?.(tableKey, origin)?.catch(() => {});
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
        // Read before the new chat replaces this one.
        const collection = next.definition.prompt?.collectionHint
            ? collectionToCarry(runs, runActions, searchableLibraryIds)
            : null;
        if ((await newThread({ window: win })) === undefined) return;
        onDismiss();
        startTask({ key, targetWindow: win, ...(collection ? { collection } : {}) });
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
                ) : tableTip && tableKey ? (
                    <p className="feature-credits-text">
                        {tableTip.text}{' '}
                        <a href="#" className="feature-credits-link" onClick={openTable}>
                            {tableTip.label}
                        </a>
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
