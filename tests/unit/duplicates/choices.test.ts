import { expect, it } from "vitest";
import {
    withMergeChoices,
    withMergeChoicesForDisplay,
    updateMergeItemsChoices,
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
