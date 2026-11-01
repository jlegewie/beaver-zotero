import { Setter } from "jotai";
import { checkExternalReferencesAtom } from "../atoms/externalReferences";
import { addExternalReferencesToMappingAtom } from "@beaver/agent-core/citations/externalReferences";
import { combineSnapshotList } from "@beaver/agent-core/citations/externalRecords";
import type { ExternalReference } from "@beaver/agent-core/types/externalReferences";
import { loadFullItemDataWithAllTypes } from "../../src/utils/zoteroUtils";
import { resolveItemReference } from "../../src/utils/libraryIdentity";
import { extractExternalSearchData, extractLookupWorkData, isExternalSearchResult, isLookupWorkResult } from "@beaver/agent-core/run-state/toolResultTypes";
import { ToolReturnPart, isUnsuccessfulToolReturn } from "@beaver/agent-core/agents/types";
import { extractZoteroReferences } from "@beaver/agent-core/run-state/toolResultTypes";
import { isExternalReferenceListView, isToolResultView, relatedWorksViewInfo } from "@beaver/agent-core/run-state/toolResultViews";
import { logger } from "@beaver/agent-core/platform/logger";

/**
 * Process tool return results: extract and cache external references,
 * and load Zotero item data for display.
 * @param part Tool return part to process
 * @param set Jotai setter for state updates
 */
export async function processToolReturnResults(
    part: ToolReturnPart,
    set: Setter
): Promise<void> {
    if (part.part_kind !== "tool-return") return;
    // A non-success return carries an explanatory message where the result
    // payload would be, so there are no references to cache or items to preload.
    if (isUnsuccessfulToolReturn(part)) return;

    // Prefer the backend's canonical, fully hydrated view. This covers every
    // tool that returns external references (including find_related_works),
    // without requiring this ingestion path to maintain a second tool-name
    // allowlist alongside the render layer.
    const view = part.metadata?.view;
    if (isToolResultView(view) && isExternalReferenceListView(view)) {
        // Every snapshot the tool produced: its rows, the other-source
        // snapshots of the same ids, and the work a related-works list is for.
        const snapshots: ExternalReference[] = [
            ...(view.references ?? []),
            ...(view.extra_snapshots ?? []),
        ];
        const relatedWork = relatedWorksViewInfo(view)?.work;
        if (relatedWork?.source_id) snapshots.push(relatedWork);
        if (snapshots.length > 0) {
            logger(`processToolReturnResults: Adding ${snapshots.length} external reference snapshots from view`, 1);
            set(addExternalReferencesToMappingAtom, snapshots);
            // The library check matches on every identifier the tool's
            // snapshots carry, so it runs on their combination per id.
            set(checkExternalReferencesAtom, [...combineSnapshotList(snapshots).values()]);
        }
    } else if (
        part.metadata &&
        isExternalSearchResult(part.tool_name, part.content, part.metadata)
    ) {
        const externalReferences = extractExternalSearchData(part.content, part.metadata)?.references;
        if (externalReferences) {
            logger(`processToolReturnResults: Adding ${externalReferences.length} external references to mapping`, 1);
            set(addExternalReferencesToMappingAtom, externalReferences);
            set(checkExternalReferencesAtom, externalReferences);
        }
    } else if (
        part.metadata &&
        isLookupWorkResult(part.tool_name, part.content, part.metadata)
    ) {
        const externalReferences = extractLookupWorkData(part.content, part.metadata)?.references;
        if (externalReferences && externalReferences.length > 0) {
            logger(`processToolReturnResults: Adding ${externalReferences.length} lookup references to mapping`, 1);
            set(addExternalReferencesToMappingAtom, externalReferences);
            set(checkExternalReferencesAtom, externalReferences);
        }
    }

    // Load item data
    if (part.part_kind === "tool-return") {
        const itemReferences = extractZoteroReferences(part);
        if (itemReferences) {
            logger(`processToolReturnResults: Loading ${itemReferences.length} item data`, 1);
            // Resolve through the tri-state helper: refs whose library isn't
            // available on this device (or whose key is gone) are skipped
            // instead of hitting Zotero with an unresolvable library id.
            const resolutions = await Promise.all(itemReferences.map(ref => resolveItemReference(ref)));
            const items = resolutions
                .filter((res): res is Extract<typeof res, { status: 'found' }> => res.status === 'found')
                .map(res => res.item);
            await loadFullItemDataWithAllTypes(items);
        }
    }
    
}
