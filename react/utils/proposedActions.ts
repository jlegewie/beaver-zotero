import { hasAppliedZoteroItem, ProposedAction, isAnnotationAction } from "../types/chat/proposedActions";
import { getZoteroItemFromProposedAction } from "../types/chat/proposedActions";

/**
 * Validates that a proposed action has been applied and is still valid.
 * @param action - The proposed action to validate
 * @returns True if the action has been applied and is still valid, false otherwise
 */
export async function validateAppliedAction(
    action: ProposedAction
): Promise<boolean> {
    if (!hasAppliedZoteroItem(action)) return true;

    // Get the Zotero item from the proposed action
    const item = await getZoteroItemFromProposedAction(action);
    if (!item) return false;

    // If the item is not an annotation, return false
    if (isAnnotationAction(action) && !item.isAnnotation()) return false;

    // If the item is an annotation, return true
    return true;
}