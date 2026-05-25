import type { AgentAction } from './agentActions';

/**
 * Count user-visible PDF annotations represented by an applied action.
 */
export function getAppliedPdfAnnotationCount(action: AgentAction): number {
    if (
        action.action_type === 'create_highlight_annotations' ||
        action.action_type === 'create_note_annotations'
    ) {
        const created = Array.isArray(action.result_data?.created)
            ? action.result_data.created
            : [];
        const clientItemIds = created
            .map((item) => item?.client_item_id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);

        if (clientItemIds.length > 0) {
            return new Set(clientItemIds).size;
        }

        if (created.length > 0) return created.length;

        const proposedItems = Array.isArray(action.proposed_data?.items)
            ? action.proposed_data.items
            : [];
        return proposedItems.length;
    }

    const hasAppliedZoteroItem =
        action.status === 'applied' &&
        Boolean(action.result_data?.zotero_key) &&
        Boolean(action.result_data?.library_id);

    if (
        hasAppliedZoteroItem &&
        (
            action.action_type === 'highlight_annotation' ||
            action.action_type === 'note_annotation'
        )
    ) {
        return 1;
    }

    return 0;
}
