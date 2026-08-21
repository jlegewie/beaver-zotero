import { describe, expect, it } from "vitest";

import {
    getActionLabel,
    getActionTitle,
    hasFailedUndo,
} from "../../../react/host/zotero/components/agentActionViewHelpers";
import type { AgentAction } from "@beaver/agent-core/agents/agentActionTypes";

/**
 * `edit_annotations` and `delete_annotations` are two tools sharing one action
 * type, and these helpers switch on the TOOL name. A deletion therefore has to
 * be routed explicitly, or it falls through to the generic default and loses
 * its count.
 */
const editData = (count: number) => ({
    operation: "edit",
    edits: [
        {
            annotation_refs: Array.from({ length: count }, (_, i) => ({
                library_id: 1,
                zotero_key: `KEY${i}`,
            })),
            changes: { color: "blue" },
        },
    ],
});

const deleteData = (count: number) => ({
    operation: "delete",
    annotation_refs: Array.from({ length: count }, (_, i) => ({
        library_id: 1,
        zotero_key: `KEY${i}`,
    })),
});

describe("annotation action labels", () => {
    it("labels an edit by its target count", () => {
        expect(getActionLabel("edit_annotations", editData(1))).toBe(
            "Edit Annotation",
        );
        expect(getActionLabel("edit_annotations", editData(3))).toBe(
            "Edit 3 Annotations",
        );
    });

    it("labels a deletion by its target count", () => {
        expect(getActionLabel("delete_annotations", deleteData(1))).toBe(
            "Delete Annotation",
        );
        expect(getActionLabel("delete_annotations", deleteData(4))).toBe(
            "Delete 4 Annotations",
        );
    });

    it("has no title, so the header never repeats the label", () => {
        expect(getActionTitle("edit_annotations", editData(2), null, [])).toBe(
            null,
        );
        expect(
            getActionTitle("delete_annotations", deleteData(2), null, []),
        ).toBe(null);
    });

    /**
     * Streaming tool arguments carry the model's `annotation_ids` and no
     * `operation`, so the label has to count that shape and take its verb from
     * the tool name.
     */
    it("labels streaming tool arguments", () => {
        expect(
            getActionLabel("delete_annotations", {
                annotation_ids: ["a", "b", "c"],
            }),
        ).toBe("Delete 3 Annotations");
        expect(
            getActionLabel("edit_annotations", {
                edits: [
                    { annotation_ids: ["a", "b"], changes: { color: "blue" } },
                ],
            }),
        ).toBe("Edit 2 Annotations");
    });
});

describe("hasFailedUndo", () => {
    const errored = (overrides: Partial<AgentAction> = {}): AgentAction => ({
        id: "a1",
        run_id: "run-1",
        toolcall_id: "call-1",
        action_type: "create_note",
        status: "error",
        proposed_data: {},
        ...overrides,
    } as AgentAction);

    // Retry has to know which direction failed, and only an applied action ever
    // carries result_data — a successful undo clears it.
    it("is true for an errored action that still carries a result", () => {
        expect(hasFailedUndo([errored({ result_data: { zotero_key: "ABC" } })])).toBe(true);
    });

    it("is false for a failed apply, which never produced a result", () => {
        expect(hasFailedUndo([errored()])).toBe(false);
        expect(hasFailedUndo([errored({ result_data: null as any })])).toBe(false);
    });

    it("is false when nothing errored", () => {
        expect(hasFailedUndo([errored({ status: "applied", result_data: { zotero_key: "ABC" } })])).toBe(false);
        expect(hasFailedUndo([errored({ status: "undone" })])).toBe(false);
        expect(hasFailedUndo([])).toBe(false);
    });

    it("finds the failed undo in a batch that also has failed applies", () => {
        expect(hasFailedUndo([
            errored(),
            errored({ id: "a2", result_data: { zotero_key: "ABC" } }),
        ])).toBe(true);
    });
});

describe("completed action labels", () => {
    it("puts the verb-only labels into the past tense", () => {
        expect(getActionLabel("organize_items", {}, true)).toBe("Organized");
        expect(getActionLabel("create_items", {}, true)).toBe("Imported");
        expect(getActionLabel("create_note", {}, true)).toBe("Created Note");
        expect(getActionLabel("edit_metadata", {}, true)).toBe("Edited");
        expect(getActionLabel("edit_note_batch", {}, true)).toBe("Edited Note");
        expect(getActionLabel("create_collection", {}, true)).toBe("Created Collection");
        expect(getActionLabel("delete_annotations", deleteData(2), true)).toBe("Deleted 2 Annotations");
        expect(getActionLabel("edit_annotations", editData(2), true)).toBe("Edited 2 Annotations");
    });

    it("leaves the labels alone where the verb lives in the title instead", () => {
        // manage_tags / manage_collections put "Delete tag ...", "Rename ... → ..."
        // in the title, so a past-tense label would contradict it.
        expect(getActionLabel("manage_tags", { name: "x" }, true)).toBe("Tag");
        expect(getActionLabel("manage_collections", { action: "delete" }, true)).toBe("Collection");
        // Already a noun phrase.
        expect(getActionLabel("create_highlight_annotations", { items: [1, 2, 3] }, true)).toBe("3 Highlights");
    });

    it("defaults to the imperative, so proposals are unaffected", () => {
        expect(getActionLabel("organize_items", {})).toBe("Organize");
        expect(getActionLabel("create_note", {})).toBe("Create Note");
        expect(getActionLabel("delete_annotations", deleteData(2))).toBe("Delete 2 Annotations");
    });
});
