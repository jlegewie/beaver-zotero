import { atom } from "jotai";
import type {
    MergeItemsChoices,
    MergeItemsProposedData,
} from "@beaver/agent-core/protocol/duplicates";
import type { AgentAction } from "@beaver/agent-core/agents/agentActionTypes";

/** Unsaved choices are local to the action's reviewing window. */
export const mergeItemsChoicesAtom = atom<Record<string, MergeItemsChoices>>(
    {},
);
export function withMergeChoices(
    action: AgentAction,
    choices?: MergeItemsChoices,
): AgentAction {
    if (action.action_type !== "merge_items") return action;
    choices ??= action.result_data?.applied_choices;
    if (!choices) return action;
    const data = action.proposed_data as MergeItemsProposedData;
    const members = [data.master_item_id, ...data.other_item_ids];
    if (!members.includes(choices.master_item_id))
        throw new Error("Selected master is not a member of this merge.");
    return {
        ...action,
        proposed_data: {
            ...data,
            ...choices,
            other_item_ids: members.filter(
                (id) => id !== choices.master_item_id,
            ),
        },
    };
}

/**
 * Render-safe variant. A persisted record whose choices no longer match its
 * proposal degrades to the untouched proposal, because a throw here would take
 * down the whole chat tree rather than one card. The apply path still uses
 * `withMergeChoices` and refuses such a record.
 */
export function withMergeChoicesForDisplay(action: AgentAction): AgentAction {
    try {
        return withMergeChoices(action);
    } catch {
        return action;
    }
}

/** Apply a UI delta against the latest draft, including batched field selections. */
export function updateMergeItemsChoices(
    previous: MergeItemsChoices | undefined,
    defaults: MergeItemsChoices,
    patch: Partial<MergeItemsChoices>,
): MergeItemsChoices {
    const current = previous ?? defaults;
    return {
        ...current,
        ...patch,
        field_sources: { ...current.field_sources, ...patch.field_sources },
    };
}
