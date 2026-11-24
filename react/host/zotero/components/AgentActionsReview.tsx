import React from 'react';
import { useAtomValue } from 'jotai';
import { externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { webPageId } from '@beaver/agent-core/citations/externalRecords';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { workKeys } from '@beaver/agent-ui/chat/CitedSourcesList';
import { AgentRun } from '@beaver/agent-core/agents/types';
import {
    agentActionsForRunsAtom,
    isItemCreatingAgentAction,
    isImportItemAgentAction,
    ItemCreatingAgentAction,
} from '../../../agents/agentActions';
import { importActionReference } from '../../../utils/importItemDisplay';
import CreateItemAgentActionDisplay from './CreateItemAgentActionDisplay';
import ArtifactsList from './reviewChanges/ArtifactsList';
import ChangesCard from './reviewChanges/ChangesCard';
import { useArtifactRows, useChangesRows, useEditedNoteArtifacts } from './reviewChanges/useRunActionRows';
import { useTableArtifactRows } from './reviewChanges/useTableArtifactRows';
import { toolCallOrder } from './reviewChanges/runArtifacts';

interface AgentActionsReviewProps {
    /** The one or more runs that make up a single answer. */
    runs: AgentRun[];
}

/** The external id an item-creating citation action imports. */
function actionExternalId(action: ItemCreatingAgentAction): string | undefined {
    return isImportItemAgentAction(action) ? action.proposed_data.source?.external_id : action.proposed_data.item?.source_id;
}

/**
 * One import per work: a pending import of a web page that is a paper (its
 * record names a DOI, arXiv id or PMID) is left out when the answer also cites
 * that work's own record, as the sources list merges the two.
 */
export function withoutDuplicateWebPages(
    actions: ItemCreatingAgentAction[],
    references: Record<string, ExternalReference>,
): ItemCreatingAgentAction[] {
    const keysOf = (action: ItemCreatingAgentAction) => {
        const id = actionExternalId(action);
        return id ? workKeys(references[id]) : [];
    };
    const isWebPage = (action: ItemCreatingAgentAction) => !!webPageId(actionExternalId(action));
    const works = new Set(actions.filter((action) => !isWebPage(action)).flatMap(keysOf));
    return actions.filter((action) => !(isWebPage(action) && action.status === 'pending' && keysOf(action).some((key) => works.has(key))));
}

/**
 * Displays agent actions for one terminal answer: what it produced (notes and
 * tables), then the imports it suggests, then one card containing every
 * library change it proposed, pending or settled. A continued answer spans
 * several runs, but is still one answer and therefore gets one review block.
 *
 * The three are disjoint by construction, so an answer's work is never
 * reported twice, with one exception: a note the answer edited is both a
 * deliverable (its artifact row, to open or export) and a set of changes (in
 * the changes card, to review or undo). Most answers show exactly one of them.
 */
export const AgentActionsReview: React.FC<AgentActionsReviewProps> = ({ runs }) => {
    const referenceMapping = useAtomValue(externalReferenceMappingAtom);
    const runIds = React.useMemo(() => runs.map((run) => run.id), [runs]);
    // Scoped to these runs: an action written elsewhere in the thread leaves
    // this answer's review block alone.
    const actionsByRun = useAtomValue(React.useMemo(() => agentActionsForRunsAtom(runIds), [runIds]));
    const changesRows = useChangesRows(runIds);
    const artifactRows = useArtifactRows(runIds);
    // The order the answer made its tool calls in, for the artifact cards.
    const order = React.useMemo(() => toolCallOrder(runs), [runs]);
    const editedNotes = useEditedNoteArtifacts(runIds, order);
    const tableRows = useTableArtifactRows(runs);
    const lastRun = runs[runs.length - 1];

    // Citation imports retain their per-run control because that component's
    // mutations are scoped to a run. The library changes below are aggregated.
    // create_item (older clients) and import_item (create_items v2) proposals
    // share the card; an import_item carries no ExternalReference of its own.
    const citationCount = React.useCallback((action: ItemCreatingAgentAction): number => (
        isImportItemAgentAction(action)
            ? importActionReference(action.proposed_data, referenceMapping).citation_count ?? 0
            : action.proposed_data.item?.citation_count ?? 0
    ), [referenceMapping]);
    const createItemActionsByRun = React.useMemo(() => runs.map((run, index) => ({
        runId: run.id,
        actions: withoutDuplicateWebPages(actionsByRun[index].filter(
            (action) => isItemCreatingAgentAction(action) && action.toolcall_id === 'citations'
        ) as ItemCreatingAgentAction[], referenceMapping).sort((a, b) => citationCount(b) - citationCount(a)),
    })).filter(({ actions }) =>
        actions.length > 0 &&
        !actions.every((action) => action.status === 'rejected' || action.status === 'undone')
    ), [actionsByRun, runs, citationCount, referenceMapping]);

    // Don't show during streaming
    if (!lastRun || lastRun.status === 'in_progress') {
        return null;
    }

    const hasCreateItems = createItemActionsByRun.length > 0;

    // Every change the answer touched gets the card, whatever their number and
    // whatever became of them: one place, one label, so "what did this do to my
    // library" is answered the same way for every run.
    const showChangesCard = changesRows.length > 0;

    // The three displays are independent: each renders whenever the answer has
    // something for it, and an answer commonly has something for only one.
    if (
        !hasCreateItems
        && !showChangesCard
        && artifactRows.length === 0
        && editedNotes.length === 0
        && tableRows.length === 0
    ) {
        return null;
    }

    return (
        <div className="px-4 display-flex flex-col gap-2">
            {/* What the answer made comes first: it is the most likely thing to be
                opened, and the answer above it has just finished describing it. */}
            <ArtifactsList rows={artifactRows} tableRows={tableRows} editedNotes={editedNotes} order={order} />
            {createItemActionsByRun.map(({ runId, actions }) => (
                <CreateItemAgentActionDisplay
                    key={runId}
                    runId={runId}
                    actions={actions}
                />
            ))}
            {showChangesCard && <ChangesCard runId={lastRun.id} rows={changesRows} />}
        </div>
    );
};

export default AgentActionsReview;
