import { Setter } from "jotai";
import { addExternalReferencesToMappingAtom, checkExternalReferencesAtom } from "../atoms/externalReferences";
import { loadFullItemDataWithAllTypes } from "../../src/utils/zoteroUtils";
import { resolveItemReference } from "../../src/utils/libraryIdentity";
import { extractExternalSearchData, extractLookupWorkData, isExternalSearchResult, isLookupWorkResult } from "./toolResultTypes";
import { ToolReturnPart } from "./types";
import { extractZoteroReferences } from "./toolResultTypes";
import { logger } from "../../src/utils/logger";

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

    // Check for external references and populate cache
    if (
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