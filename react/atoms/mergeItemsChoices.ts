import { atom } from "jotai";
import type {
    MergeItemsChoices,
    MergeItemsProposedData,
    MergeItemsResultData,
} from "@beaver/agent-core/protocol/duplicates";
import type { AgentAction } from "@beaver/agent-core/agents/agentActionTypes";
import type { ZoteroItemReference } from "@beaver/agent-core/types/zotero";

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

/**
 * The record a merge kept while the merge is in the library, for revealing the
 * combined item: once applied, and after a failed undo, which leaves the merge
 * in place with its result saved. Read from the persisted result, so it needs
 * no live lookup. `library_id` is left unresolved: callers resolve the portable
 * `library_ref` on this device.
 */
export function getMergedItemReference(action: AgentAction): ZoteroItemReference | null {
    const merged = action.status === "applied" || (action.status === "error" && action.result_data != null);
    if (action.action_type !== "merge_items" || !merged) return null;
    const result = action.result_data as MergeItemsResultData | undefined;
    const kept = result?.preview?.members.find((m) => m.item_id === result.master_item_id);
    if (!kept?.library_ref || !kept.zotero_key) return null;
    return { library_id: 0, library_ref: kept.library_ref, zotero_key: kept.zotero_key };
}
