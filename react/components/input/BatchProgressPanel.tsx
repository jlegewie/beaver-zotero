import React, { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import BatchProgressBar from '@beaver/agent-ui/chat/BatchProgressBar';
import type { BatchReviewStatus } from '@beaver/agent-ui/chat/BatchProgressBar';
import type { BatchProgressEntry } from '@beaver/agent-core/run-state/batchProgress';
import { selectTrackedBatch } from '@beaver/agent-core/run-state/batchProgress';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { batchProgressAtom } from '../../atoms/agentRunAtoms';
import { threadAgentActionsAtom } from '../../agents/agentActions';

/**
 * Agent action types each batch operation's work arrives as.
 *
 * The batch ledger counts an item resolved once the agent has PROPOSED the
 * edit, so "184 of 184" can be true while 184 changes are still waiting to be
 * approved. Only the client knows what became of them — this is how the two are
 * joined, per operation, so a tagging batch is never credited with an
 * annotation batch's unreviewed proposals.
 *
 * `extract` is absent on purpose: it reads documents and proposes nothing, so
 * it has no review state to report.
 */
const ACTION_TYPES_BY_OPERATION: Record<string, ReadonlySet<string>> = {
    tag: new Set(['organize_items', 'manage_tags']),
    sort: new Set(['organize_items', 'create_collection', 'manage_collections']),
    annotate: new Set(['create_highlight_annotations', 'create_note_annotations']),
    edit_metadata: new Set(['edit_metadata']),
    create_notes: new Set(['create_note']),
};

/** What the user still has to decide on, for the batch being tracked. */
function reviewStatus(
    batch: BatchProgressEntry | null,
    actions: AgentAction[],
): BatchReviewStatus | null {
    if (!batch) return null;
    const types = ACTION_TYPES_BY_OPERATION[batch.operation];
    if (!types) return null;
    let pending = 0;
    let rejected = 0;
    for (const action of actions) {
        if (!types.has(action.action_type)) continue;
        if (action.status === 'pending') pending += 1;
        else if (action.status === 'rejected') rejected += 1;
    }
    if (!pending && !rejected) return null;
    return { pending, rejected };
}

/**
 * Live batch progress above the composer, wired to Zotero.
 *
 * Owns the one thing neither the backend nor the shared bar can know: how many
 * of the batch's proposed changes the user has actually acted on. Everything
 * else — including the collection names, which the backend composes from the
 * `collection_names` this client returns during action validation — is the
 * backend's record, rendered verbatim.
 *
 * Renders nothing when no batch is open, or when every open batch is below the
 * size the backend decided is worth a progress bar.
 */
const BatchProgressPanel: React.FC = () => {
    const stamp = useAtomValue(batchProgressAtom);
    const actions = useAtomValue(threadAgentActionsAtom);

    const tracked = useMemo(() => selectTrackedBatch(stamp), [stamp]);
    const others = useMemo(
        () => (stamp?.batches ?? []).filter((entry) => entry !== tracked),
        [stamp, tracked],
    );
    const review = useMemo(() => reviewStatus(tracked, actions), [tracked, actions]);

    if (!tracked) return null;

    return (
        <BatchProgressBar
            batch={tracked}
            otherBatches={others}
            review={review}
        />
    );
};

export default BatchProgressPanel;
