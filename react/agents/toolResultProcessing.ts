import { Setter } from "jotai";
import { addExternalReferencesToMappingAtom } from "../atoms/externalReferences";
import { loadFullItemDataWithAllTypes } from "../../src/utils/zoteroUtils";
import { extractExternalSearchData, isExternalSearchResult } from "./toolResultTypes";
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
        }
    }

    // Load item data
    if (part.part_kind === "tool-return") {
        const itemReferences = extractZoteroReferences(part);
        if (itemReferences) {
            logger(`processToolReturnResults: Loading ${itemReferences.length} item data`, 1);
            const itemPromises = itemReferences.map(ref => Zotero.Items.getByLibraryAndKeyAsync(ref.library_id, ref.zotero_key));
            const items = (await Promise.all(itemPromises)).filter(Boolean) as Zotero.Item[];
            await loadFullItemDataWithAllTypes(items);
        }
    }
    
}