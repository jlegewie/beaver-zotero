import { AgentRun, ToolCallPart } from '@beaver/agent-core/agents/types';
import { getLabelEnrichmentNeeds, type ToolCallLabelEnrich } from '@beaver/agent-core/run-state/toolLabels';
import { extractZoteroReferencesFromToolCall, parseArgs } from '@beaver/agent-core/run-state/toolCallRequest';
import { isToolResultView, type ToolResultView } from '@beaver/agent-core/run-state/toolResultViews';
import { getHost } from '@beaver/agent-ui/host';
import { parseLibraryRef, resolveLibraryRef } from '../../src/utils/libraryIdentity';

/** Host-resolved label display data, keyed by `tool_call_id`. */
export type ToolCallLabelEnrichMap = Map<string, ToolCallLabelEnrich>;

/** The hydrated view model of a tool call's return, if it has one. */
export function getToolCallResultView(
    part: ToolCallPart,
    toolResultsMap: Map<string, any>,
): ToolResultView | null {
    const result = toolResultsMap.get(part.tool_call_id);
    const rawView = result?.part_kind === 'tool-return' ? result.metadata?.view : undefined;
    return isToolResultView(rawView) ? rawView : null;
}

/**
 * Resolve the request-side display data a tool-call label needs beyond its view
 * model (pending/failed item names, `list_*` library/collection scope names)
 * through the `itemData` host slice. Returns null when nothing needs resolving
 * or the client has no such capability — the label then degrades to the raw arg.
 */
export async function resolveToolCallLabelEnrich(
    part: ToolCallPart,
    view: ToolResultView | null,
): Promise<ToolCallLabelEnrich | null> {
    const itemData = getHost().itemData;
    const needs = getLabelEnrichmentNeeds(part, view);
    if (!itemData || (!needs.itemName && !needs.scope)) return null;

    const next: ToolCallLabelEnrich = {};
    if (needs.itemName && itemData.resolveItemDisplay) {
        const ref = extractZoteroReferencesFromToolCall(part)[0];
        if (ref) {
            const display = await itemData.resolveItemDisplay(ref);
            if (display?.displayName) next.itemDisplayName = display.displayName;
        }
    }
    if (needs.scope) {
        const args = parseArgs(part);
        const libParam = args.library as string | number | undefined;
        // A portable library_ref ("u"/"g<groupID>") resolves directly to a local
        // libraryID for collection scoping; a plain numeric-ID string still parses
        // with parseInt. Library name resolution below passes libParam through raw.
        const refParsed = typeof libParam === 'string' ? parseLibraryRef(libParam) : null;
        const libId = typeof libParam === 'number'
            ? libParam
            : refParsed
                ? resolveLibraryRef({ library_ref: libParam }) ?? undefined
                : (typeof libParam === 'string' ? parseInt(libParam, 10) : undefined);
        const collParam = (args.collection_key ?? args.collection ?? args.parent_collection) as string | undefined;
        if (collParam && itemData.resolveCollectionName) {
            const name = await itemData.resolveCollectionName(collParam, Number.isNaN(libId as number) ? undefined : libId);
            if (name) next.collectionName = name;
        }
        if (libParam != null && itemData.resolveLibraryName) {
            const name = await itemData.resolveLibraryName(libParam);
            if (name) next.libraryName = name;
        }
    }
    return Object.keys(next).length ? next : null;
}

/**
 * Resolve label display data for every tool call in `runs`, for export paths
 * (clipboard, saved notes) that build labels outside the live render tree.
 * Without it, a `list_*` label falls back to the raw library arg ("u") instead
 * of the library name.
 */
export async function resolveToolCallLabelEnrichMap(
    runs: AgentRun[],
    toolResultsMap: Map<string, any>,
): Promise<ToolCallLabelEnrichMap> {
    const map: ToolCallLabelEnrichMap = new Map();
    if (!getHost().itemData) return map;

    const parts: ToolCallPart[] = [];
    for (const run of runs) {
        for (const message of run.model_messages) {
            for (const part of message.parts) {
                if (part.part_kind === 'tool-call') parts.push(part as ToolCallPart);
            }
        }
    }

    const resolved = await Promise.all(
        parts.map(part => resolveToolCallLabelEnrich(part, getToolCallResultView(part, toolResultsMap))),
    );
    parts.forEach((part, i) => {
        const enrich = resolved[i];
        if (enrich) map.set(part.tool_call_id, enrich);
    });
    return map;
}
