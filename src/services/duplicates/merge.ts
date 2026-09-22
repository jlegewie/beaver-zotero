import type {
    MergeItemsProposedData,
    MergeItemsResultData,
    MergeItemSnapshot,
} from "@beaver/agent-core/protocol/duplicates";
import type { AgentAction } from "@beaver/agent-core/agents/agentActionTypes";
import type {
    ActionValidateRequest,
    ActionExecuteRequest,
} from "../agentDataProvider/operationContext";
import type {
    WSAgentActionValidateResponse,
    WSAgentActionExecuteResponse,
} from "@beaver/agent-core/protocol/agentProtocol";
import {
    getDeferredToolPreference,
    checkLibraryExcluded,
} from "../agentDataProvider/utils";
import {
    modelObjectId,
    parseItemReference,
    resolveLibraryRef,
} from "../../utils/libraryIdentity";
import {
    describeGroup,
    duplicateError,
    loadDuplicateItems,
    stableJSON,
} from "./discovery";
import {
    checkAborted,
    type TimeoutContext,
} from "../agentDataProvider/timeout";

import { nativeMergeTransaction } from "./nativeMergeTransaction";
import { dismissNotePreviews } from "../notePreviews";

const OMIT = new Set(["key", "version", "dateModified", "lastRead"]);
async function snapshot(
    item: Zotero.Item,
    preserveReaderState = false,
): Promise<Record<string, unknown>> {
    await item.loadAllData();
    return JSON.parse(
        JSON.stringify(
            Object.fromEntries(
                Object.entries(item.toJSON({ mode: "full" })).filter(
                    ([k]) =>
                        !OMIT.has(k) ||
                        (preserveReaderState && k === "lastRead"),
                ),
            ),
        ),
    );
}
/** Includes children and the same-library inbound relations native merging rewrites. */
async function affectedItems(
    parents: Zotero.Item[],
    enforceLimit = true,
    ctx?: TimeoutContext,
): Promise<Zotero.Item[]> {
    const all = new Map<number, Zotero.Item>();
    async function visit(item: Zotero.Item): Promise<void> {
        if (ctx) checkAborted(ctx, "merge_items:inventory");
        if (all.has(item.id)) return;
        all.set(item.id, item);
        await item.loadAllData();
        const ids: number[] = item.isRegularItem()
            ? [...item.getAttachments(true), ...item.getNotes(true)]
            : item.isFileAttachment()
              ? (item as any).getAnnotations(true, true)
              : [];
        for (const child of await Zotero.Items.getAsync(ids))
            await visit(child);
    }
    for (const parent of parents) await visit(parent);
    for (const item of [...all.values()]) {
        for (const relation of await (Zotero as any).Relations.getByObject(
            "item",
            Zotero.URI.getItemURI(item),
        )) {
            if (relation.subject.libraryID === parents[0].libraryID)
                all.set(relation.subject.id, relation.subject);
        }
    }
    if (enforceLimit && all.size > 2000)
        throw duplicateError(
            "This merge affects more than 2,000 objects. Merge a smaller group.",
        );
    return [...all.values()];
}
/**
 * Tear down any in-editor diff preview over the affected notes and wait for the
 * editor restore. This runs before any transaction is opened: the teardown
 * awaits iframe round trips and can take over a second, and the editor writes
 * it settles would otherwise wait on the very transaction that is holding the
 * database.
 */
async function settleNotePreviews(items: Zotero.Item[]): Promise<void> {
    for (const item of items)
        if (item.isNote() || item.isAttachment())
            await dismissNotePreviews(item.libraryID, item.key);
}
async function snapshots(
    items: Zotero.Item[],
    ctx?: TimeoutContext,
): Promise<Record<string, Record<string, unknown>>> {
    const state: Record<string, Record<string, unknown>> = {};
    for (const item of items) {
        if (ctx) checkAborted(ctx, "merge_items:snapshots");
        state[modelObjectId(item.libraryID, item.key)] = await snapshot(item);
    }
    return state;
}
function checkWritable(items: Zotero.Item[]): void {
    const libraryID = items[0].libraryID;
    const excluded = checkLibraryExcluded(libraryID);
    if (excluded) throw duplicateError(excluded.message, "library_excluded");
    if (!(Zotero.Libraries.get(libraryID) as any)?.editable)
        throw duplicateError("Library is read-only.", "library_not_editable");
    if (new Set(items.map((i) => i.itemTypeID)).size !== 1)
        throw duplicateError("All items must have the same item type.");
}
function validateChoices(
    data: MergeItemsProposedData,
    items: Zotero.Item[],
): void {
    const memberIDs = new Set(
        items.map((i) => modelObjectId(i.libraryID, i.key)),
    );
    const master = items[0];
    for (const [field, source] of Object.entries(data.field_sources || {})) {
        const fieldID = Zotero.ItemFields.getID(field);
        if (
            !memberIDs.has(source) ||
            !fieldID ||
            !Zotero.ItemFields.isValidForType(fieldID, master.itemTypeID) ||
            ["dateAdded", "dateModified"].includes(field)
        ) {
            throw duplicateError(
                `Invalid field source for ${field}. Choose an editable field and a member of this merge.`,
            );
        }
    }
    if (
        data.creators_source_item_id &&
        !memberIDs.has(data.creators_source_item_id)
    )
        throw duplicateError("Creator source must be a member of this merge.");
}
export async function validateMergeItemsAction(
    request: ActionValidateRequest,
): Promise<WSAgentActionValidateResponse> {
    const data = request.action_data as MergeItemsProposedData;
    const items = await loadDuplicateItems([
        data.master_item_id,
        ...(data.other_item_ids || []),
    ]);
    checkWritable(items);
    const normalized = {
        ...data,
        master_item_id: modelObjectId(items[0].libraryID, items[0].key),
        other_item_ids: items
            .slice(1)
            .map((i) => modelObjectId(i.libraryID, i.key)),
    };
    validateChoices(normalized, items);
    const preview = await describeGroup(items, true);
    // Previews stay open until execute: a diff preview never saves, so the
    // snapshot reads the saved notes, and a rejected merge leaves them intact.
    const affected = await affectedItems(items);
    const state = await snapshots(affected);
    checkWritable(items);
    return {
        type: "agent_action_validate_response",
        request_id: request.request_id,
        valid: true,
        preference: getDeferredToolPreference(
            "merge_items",
            normalized,
            request.operation,
        ),
        current_value: preview,
        normalized_action_data: { ...normalized, preview, snapshot: state },
    };
}
export async function applyMerge(
    data: MergeItemsProposedData,
    ctx?: TimeoutContext,
): Promise<MergeItemsResultData> {
    const items = await loadDuplicateItems([
        data.master_item_id,
        ...(data.other_item_ids || []),
    ]);
    checkWritable(items);
    validateChoices(data, items);
    if (!data.snapshot)
        throw duplicateError(
            "This merge has no reviewed snapshot. Propose it again.",
            "snapshot_required",
        );
    const affected = await affectedItems(items, true, ctx);
    await settleNotePreviews(affected);
    const preview = await describeGroup(items, true);
    let mutationStarted = false;
    try {
        return await nativeMergeTransaction(
            items[0],
            items.slice(1),
            async (nativeMerge) => {
                checkWritable(items);
                if (ctx) checkAborted(ctx, "merge_items:before_merge");
                const before = await snapshots(affected, ctx);
                // Older proposals can contain the reader's volatile timestamp too.
                const reviewed = Object.fromEntries(
                    Object.entries(data.snapshot!).map(([id, value]) => [
                        id,
                        Object.fromEntries(
                            Object.entries(value).filter(
                                ([field]) => !OMIT.has(field),
                            ),
                        ),
                    ]),
                );
                if (stableJSON(before) !== stableJSON(reviewed))
                    throw duplicateError(
                        "Items changed since this merge was proposed. Inspect and propose the merge again.",
                        "stale_snapshot",
                    );
                // The high-water mark is read inside the native transaction, before
                // any native saves. It identifies genuinely new objects, including
                // embedded notes, independently of the scope of the before snapshot.
                const lastExistingID = Number(
                    await Zotero.DB.valueQueryAsync(
                        "SELECT COALESCE(MAX(itemID), 0) FROM items",
                    ),
                );
                if (ctx) checkAborted(ctx, "merge_items:before_native_merge");
                const byID = new Map(
                    items.map((i) => [modelObjectId(i.libraryID, i.key), i]),
                );
                mutationStarted = true;
                for (const [field, id] of Object.entries(
                    data.field_sources || {},
                ))
                    items[0].setField(field, byID.get(id)!.getField(field));
                if (data.creators_source_item_id)
                    items[0].setCreators(
                        byID.get(data.creators_source_item_id)!.getCreators(),
                    );
                await nativeMerge();
                if (ctx) checkAborted(ctx, "merge_items:after_native_merge");
                const afterItems = await affectedItems(items, false, ctx);
                for (const old of affected)
                    if (!afterItems.some((i) => i.id === old.id))
                        afterItems.push(old);
                const after = await snapshots(afterItems, ctx);
                const changes: MergeItemSnapshot[] = [];
                for (const item of afterItems) {
                    const item_id = modelObjectId(item.libraryID, item.key);
                    const created = item.id > lastExistingID;
                    if (
                        !(item_id in before) &&
                        (!created ||
                            !item.isNote() ||
                            item.parentID !== items[0].id)
                    ) {
                        throw duplicateError(
                            "The native merge affected an object outside its reviewed inventory.",
                            "untracked_merge_object",
                        );
                    }
                    if (
                        stableJSON(before[item_id]) !==
                        stableJSON(after[item_id])
                    )
                        changes.push({
                            item_id,
                            before: before[item_id] ?? null,
                            after: after[item_id],
                            created_by_merge: created,
                        });
                }
                const result: MergeItemsResultData = {
                    applied_choices: {
                        master_item_id: data.master_item_id,
                        field_sources: data.field_sources,
                        creators_source_item_id: data.creators_source_item_id,
                    },
                    master_item_id: data.master_item_id,
                    merged_item_ids: data.other_item_ids,
                    preview,
                    changes,
                };
                // Serialization and cancellation must succeed before SQLite commits.
                JSON.stringify(result);
                checkWritable(items);
                if (ctx) checkAborted(ctx, "merge_items:before_commit");
                return result;
            },
        );
    } catch (error) {
        if (mutationStarted)
            await Promise.all(
                affected.map((item) => (item as any).reload(undefined, true)),
            );
        throw error;
    }
}

export async function executeMergeItemsRequest(
    request: ActionExecuteRequest,
    ctx?: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const result_data = await applyMerge(
        request.action_data as MergeItemsProposedData,
        ctx,
    );
    return {
        type: "agent_action_execute_response",
        request_id: request.request_id,
        success: true,
        result_data,
    };
}
export async function executeMergeItemsAction(
    action: AgentAction,
): Promise<MergeItemsResultData> {
    return applyMerge(action.proposed_data as MergeItemsProposedData);
}
export async function undoMergeItemsAction(action: AgentAction): Promise<void> {
    const data = action.result_data as MergeItemsResultData | undefined;
    if (!data?.changes?.length)
        throw duplicateError("The merge undo record is missing.");
    for (const change of data.changes) {
        if (change.before === null && change.created_by_merge !== true)
            throw duplicateError(
                "The undo record does not establish that this note was created by the merge.",
                "undo_conflict",
            );
        if (change.before !== null && change.created_by_merge === true)
            throw duplicateError(
                "Invalid merge creation record.",
                "undo_conflict",
            );
    }
    const loaded: { item: Zotero.Item; change: MergeItemSnapshot }[] = [];
    for (const change of data.changes) {
        const ref = parseItemReference(change.item_id);
        const libraryID = ref && resolveLibraryRef(ref);
        if (!ref || !libraryID)
            throw duplicateError("The merge library is unavailable.");
        const excluded = checkLibraryExcluded(libraryID);
        if (excluded)
            throw duplicateError(excluded.message, "library_excluded");
        if (!(Zotero.Libraries.get(libraryID) as any)?.editable)
            throw duplicateError("Library is read-only.");
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            ref.zotero_key,
        );
        if (!item)
            throw duplicateError(
                "An affected item was permanently deleted; this merge cannot be undone.",
                "undo_conflict",
            );
        loaded.push({ item, change });
    }
    await settleNotePreviews(loaded.map(({ item }) => item));
    try {
        await Zotero.DB.executeTransaction(async () => {
            for (const { item } of loaded) {
                const excluded = checkLibraryExcluded(item.libraryID);
                if (excluded)
                    throw duplicateError(excluded.message, "library_excluded");
                if (!(Zotero.Libraries.get(item.libraryID) as any)?.editable)
                    throw duplicateError("Library is read-only.");
            }
            const restores: {
                item: Zotero.Item;
                json: Record<string, unknown>;
            }[] = [];
            for (const { item, change } of loaded) {
                const current = await snapshot(item, true);
                if (!change.before) {
                    if (stableJSON(current) !== stableJSON(change.after))
                        throw duplicateError(
                            "A note created by the merge was edited; undo would overwrite those changes.",
                            "undo_conflict",
                        );
                    continue;
                }
                const fields = new Set([
                    ...Object.keys(change.before),
                    ...Object.keys(change.after),
                ]);
                for (const field of fields) {
                    if (OMIT.has(field)) continue;
                    if (
                        stableJSON(change.before[field]) ===
                        stableJSON(change.after[field])
                    )
                        continue;
                    if (
                        stableJSON(current[field]) !==
                        stableJSON(change.after[field])
                    )
                        throw duplicateError(
                            `An affected ${field} changed after the merge. Undo was not applied.`,
                            "undo_conflict",
                        );
                    if (field in change.before)
                        current[field] = change.before[field];
                    else delete current[field];
                }
                restores.push({ item, json: current });
            }
            // Restore regular parents before restoring their children.
            restores.sort(
                (a, b) =>
                    Number(b.item.isRegularItem()) -
                    Number(a.item.isRegularItem()),
            );
            for (const { item, json } of restores) {
                item.fromJSON(json, { strict: true });
                await item.save({ skipEditCheck: true } as any);
            }
            for (const { item, change } of loaded)
                if (!change.before) {
                    if (!item.isNote())
                        throw duplicateError(
                            "Unexpected new object in merge undo record.",
                            "undo_conflict",
                        );
                    await item.erase();
                }
        });
    } catch (error) {
        await Promise.all(
            loaded.map(({ item }) => (item as any).reload(undefined, true)),
        );
        throw error;
    }
}
