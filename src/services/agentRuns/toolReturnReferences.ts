/**
 * The external references a tool return carries (search results, looked-up
 * works), as snapshots for the chat's external-reference mapping. Free of
 * Zotero and React: a run session keeps its own mapping from these, and a
 * window keeps the mapping it renders with.
 */

import type { ToolReturnPart } from '@beaver/agent-core/agents/types';
import { isUnsuccessfulToolReturn } from '@beaver/agent-core/agents/types';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { extractExternalSearchData, extractLookupWorkData, isExternalSearchResult, isLookupWorkResult } from '@beaver/agent-core/run-state/toolResultTypes';
import { isExternalReferenceListView, isToolResultView, relatedWorksViewInfo } from '@beaver/agent-core/run-state/toolResultViews';

export function externalReferencesOfToolReturn(part: ToolReturnPart): ExternalReference[] {
    if (part.part_kind !== 'tool-return' || isUnsuccessfulToolReturn(part)) return [];
    // Prefer the backend's canonical, fully hydrated view. This covers every
    // tool that returns external references (including find_related_works),
    // without a second tool-name allowlist beside the render layer.
    const view = part.metadata?.view;
    if (isToolResultView(view) && isExternalReferenceListView(view)) {
        // Every snapshot the tool produced: its rows, the other-source
        // snapshots of the same ids, and the work a related-works list is for.
        const snapshots: ExternalReference[] = [...(view.references ?? []), ...(view.extra_snapshots ?? [])];
        const relatedWork = relatedWorksViewInfo(view)?.work;
        if (relatedWork?.source_id) snapshots.push(relatedWork);
        return snapshots;
    }
    if (part.metadata && isExternalSearchResult(part.tool_name, part.content, part.metadata)) {
        return extractExternalSearchData(part.content, part.metadata)?.references ?? [];
    }
    if (part.metadata && isLookupWorkResult(part.tool_name, part.content, part.metadata)) {
        return extractLookupWorkData(part.content, part.metadata)?.references ?? [];
    }
    return [];
}
