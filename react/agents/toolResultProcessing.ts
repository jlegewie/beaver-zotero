import { Setter } from "jotai";
import { checkExternalReferencesAtom } from "../atoms/externalReferences";
import { addExternalReferencesToMappingAtom } from "@beaver/agent-core/citations/externalReferences";
import { combineSnapshotList } from "@beaver/agent-core/citations/externalRecords";
import { loadFullItemDataWithAllTypes } from "../../src/utils/zoteroUtils";
import { resolveItemReference } from "../../src/utils/libraryIdentity";
import { ToolReturnPart, isUnsuccessfulToolReturn } from "@beaver/agent-core/agents/types";
import { extractZoteroReferences } from "@beaver/agent-core/run-state/toolResultTypes";
import { externalReferencesOfToolReturn } from "../../src/services/agentRuns/toolReturnReferences";
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

    const references = externalReferencesOfToolReturn(part);
    if (references.length > 0) {
        logger(`processToolReturnResults: Adding ${references.length} external references to mapping`, 1);
        set(addExternalReferencesToMappingAtom, references);
        // The library check matches on every identifier a reference's
        // snapshots carry, so it runs on their combination per id.
        set(checkExternalReferencesAtom, [...combineSnapshotList(references).values()]);
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
