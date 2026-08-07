import { Setter } from "jotai";
import { addExternalReferencesToMappingAtom, checkExternalReferencesAtom } from "../atoms/externalReferences";
import { loadFullItemDataWithAllTypes } from "../../src/utils/zoteroUtils";
import { resolveItemReference } from "../../src/utils/libraryIdentity";
import { extractExternalSearchData, extractLookupWorkData, isExternalSearchResult, isLookupWorkResult } from "./toolResultTypes";
import { ToolReturnPart, isUnsuccessfulToolReturn } from "@beaver/agent-core/agents/types";
import { extractZoteroReferences } from "./toolResultTypes";
import { logger } from "@beaver/agent-core/platform/logger";
import {
    isExternalReferenceListView,
    isToolResultView,
} from "../types/toolResultViews";
import type { ExternalReference } from "@beaver/agent-core/types/externalReferences";

/**
 * Prefer the hydrated view's references (includes library_status_unknown);
 * fall back to content+supplement merge for legacy tool returns.
 */
function externalReferencesFromToolReturn(part: ToolReturnPart): ExternalReference[] | null {
    const view = part.metadata?.view;
    if (isToolResultView(view) && isExternalReferenceListView(view)) {
        return view.references;
    }
    if (isExternalSearchResult(part.tool_name, part.content, part.metadata)) {
        return extractExternalSearchData(part.content, part.metadata)?.references ?? null;
    }
    if (isLookupWorkResult(part.tool_name, part.content, part.metadata)) {
        return extractLookupWorkData(part.content, part.metadata)?.references ?? null;
    }
    return null;
}

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

    const externalReferences = externalReferencesFromToolReturn(part);
    if (externalReferences && externalReferences.length > 0) {
        logger(`processToolReturnResults: Adding ${externalReferences.length} external references to mapping`, 1);
        set(addExternalReferencesToMappingAtom, externalReferences);
        // Local re-check resolves library_status_unknown / empty library_items.
        set(checkExternalReferencesAtom, externalReferences);
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