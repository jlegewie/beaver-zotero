import { expect, it } from "vitest";
import {
    isStaleMergeProposal,
    mergeErrorLine,
} from "../../../react/host/zotero/components/mergeItemsErrors";

const failed = (overrides: Record<string, unknown>): any => ({
    id: "m",
    action_type: "merge_items",
    status: "error",
    ...overrides,
});

it("offers no retry for a merge refused because its records changed since the proposal", () => {
    expect(isStaleMergeProposal(failed({ error_details: { error_code: "stale_snapshot" } }))).toBe(true);
    expect(
        isStaleMergeProposal(
            failed({ error_message: "Items changed since this merge was proposed. Inspect and propose the merge again." }),
        ),
    ).toBe(true);
});

it("keeps retry for other failures and for a failed undo", () => {
    expect(isStaleMergeProposal(failed({ error_message: "Library is read-only." }))).toBe(false);
    expect(
        isStaleMergeProposal(failed({ result_data: {}, error_details: { error_code: "stale_snapshot" } })),
    ).toBe(false);
    expect(isStaleMergeProposal({ ...failed({}), action_type: "edit_metadata", error_details: { error_code: "stale_snapshot" } } as any)).toBe(false);
});

it("passes the backend's wording through for an apply it could not confirm", () => {
    const message = "Zotero did not confirm whether this merge was applied. Check the items in Zotero before merging again.";
    expect(mergeErrorLine(failed({ error_message: message, error_details: { outcome: "unconfirmed" } }))).toBe(message);
});

it("rewrites raw item ids out of an unavailable-record error", () => {
    expect(mergeErrorLine(failed({ error_message: "Item u-ABCD1234 is unavailable or trashed.", error_details: { error_code: "item_unavailable" } }))).toBe(
        "Not merged. A record in this merge is in the Trash or no longer exists.",
    );
});

it("reports nothing when the action has not failed", () => {
    expect(mergeErrorLine(undefined)).toBeNull();
    expect(mergeErrorLine({ ...failed({ error_message: "x" }), status: "applied" })).toBeNull();
});

it("names internal item properties the way Zotero's item pane does", () => {
    const line = (field: string) =>
        mergeErrorLine(
            failed({
                result_data: {},
                error_message: `An affected ${field} changed after the merge. Undo was not applied.`,
            }),
        );
    expect(line("relations")).toBe(
        "Undo not applied. Related items changed after the merge, and undo would overwrite that change.",
    );
    expect(line("abstractNote")).toContain("Abstract changed after the merge");
    expect(line("parentItem")).toContain("A note or attachment was moved after the merge");
});

it("replaces the model-facing exclusion message with guidance for the user", () => {
    const line = mergeErrorLine(
        failed({
            result_data: {},
            error_message:
                'The library "My Library" is excluded from Beaver. Tell the user they can re-enable access by removing it from the excluded libraries list in Beaver Preferences.',
            error_details: { error_code: "library_excluded" },
        }),
    );
    // The merge is still in place; the record does not say the undo failed.
    expect(line).toBe(
        "Merged, but an error occurred. This library is excluded from Beaver. Re-enable it in Beaver Preferences, then retry.",
    );
});

it("does not call an acknowledgement failure a failed undo", () => {
    // The merge landed and saved its result; only reporting it to the backend failed.
    expect(mergeErrorLine(failed({ result_data: {}, error_message: "Failed to fetch" }))).toBe(
        "Merged, but an error occurred. Failed to fetch.",
    );
    expect(
        mergeErrorLine(
            failed({
                result_data: {},
                error_message: "An affected tags changed after the merge. Undo was not applied.",
                error_details: { error_code: "undo_conflict" },
            }),
        ),
    ).toContain("Undo not applied.");
});
