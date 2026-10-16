import { expect, it } from "vitest";
import {
    withMergeChoices,
    withMergeChoicesForDisplay,
    updateMergeItemsChoices,
    getMergedItemReference,
} from "../../../react/atoms/mergeItemsChoices";
import { buildPreviewData } from "../../../react/host/zotero/components/agentActionViewHelpers";
const action: any = {
    id: "merge",
    action_type: "merge_items",
    status: "undone",
    proposed_data: {
        master_item_id: "u-AAAA1111",
        other_item_ids: ["u-BBBB2222"],
        snapshot: { retained: true },
    },
    result_data: {
        applied_choices: {
            master_item_id: "u-BBBB2222",
            field_sources: { title: "u-AAAA1111" },
        },
    },
};
it("uses persisted user choices when reapplying a merge after history reload", () => {
    const result = withMergeChoices(action);
    expect(result.proposed_data.master_item_id).toBe("u-BBBB2222");
    expect(result.proposed_data.other_item_ids).toEqual(["u-AAAA1111"]);
    expect(result.proposed_data.snapshot).toEqual({ retained: true });
    expect(buildPreviewData("merge_items", null, action)?.actionData).toEqual(
        result.proposed_data,
    );
    expect(action.proposed_data.master_item_id).toBe("u-AAAA1111");
});
it("lets a fresh user choice override the persisted choice", () => {
    expect(
        withMergeChoices(action, { master_item_id: "u-AAAA1111" }).proposed_data
            .other_item_ids,
    ).toEqual(["u-BBBB2222"]);
});
it("rejects an unrelated master without altering the proposal", () => {
    expect(() =>
        withMergeChoices(action, { master_item_id: "u-CCCC3333" }),
    ).toThrow("not a member");
});

it("preserves batched master, field, and creator selections", () => {
    const defaults = {
        master_item_id: "u-AAAA1111",
        field_sources: { title: "u-AAAA1111" },
    };
    let draft = updateMergeItemsChoices(undefined, defaults, {
        master_item_id: "u-BBBB2222",
    });
    draft = updateMergeItemsChoices(draft, defaults, {
        field_sources: { abstractNote: "u-BBBB2222" },
    });
    draft = updateMergeItemsChoices(draft, defaults, {
        creators_source_item_id: "u-AAAA1111",
    });
    expect(draft).toEqual({
        master_item_id: "u-BBBB2222",
        field_sources: { title: "u-AAAA1111", abstractNote: "u-BBBB2222" },
        creators_source_item_id: "u-AAAA1111",
    });
});

it("renders an inconsistent persisted record instead of throwing through the tree", () => {
    const inconsistent: any = {
        ...action,
        result_data: { applied_choices: { master_item_id: "u-CCCC3333" } },
    };
    expect(() => withMergeChoices(inconsistent)).toThrow("not a member");
    expect(withMergeChoicesForDisplay(inconsistent)).toBe(inconsistent);
    expect(
        buildPreviewData("merge_items", null, inconsistent)?.actionData,
    ).toBe(inconsistent.proposed_data);
});

const appliedMerge = (status: string): any => ({
    ...action,
    status,
    result_data: {
        master_item_id: "g12-BBBB2222",
        merged_item_ids: ["g12-AAAA1111"],
        changes: [],
        preview: {
            members: [
                { item_id: "g12-AAAA1111", library_ref: "g12", zotero_key: "AAAA1111" },
                { item_id: "g12-BBBB2222", library_ref: "g12", zotero_key: "BBBB2222" },
            ],
        },
    },
});

it("reveals the record an applied merge kept, by its portable library ref", () => {
    expect(getMergedItemReference(appliedMerge("applied"))).toEqual({
        library_id: 0,
        library_ref: "g12",
        zotero_key: "BBBB2222",
    });
});

it("offers no merged item before the merge is applied or after it is undone", () => {
    expect(getMergedItemReference(appliedMerge("pending"))).toBeNull();
    expect(getMergedItemReference(appliedMerge("undone"))).toBeNull();
    expect(getMergedItemReference({ ...appliedMerge("applied"), action_type: "edit_metadata" })).toBeNull();
});

it("still reveals the kept record while a failed undo leaves the merge in place", () => {
    expect(getMergedItemReference({ ...appliedMerge("error") })?.zotero_key).toBe("BBBB2222");
    expect(getMergedItemReference({ ...appliedMerge("error"), result_data: null })).toBeNull();
});
