import { describe, expect, it } from "vitest";

import {
    getActionLabel,
    getActionTitle,
    getActionCardResolutionStatus,
    shouldAutoCollapseResolvedApproval,
} from "../../../react/host/zotero/components/agentActionViewHelpers";

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

describe("pending action visibility", () => {
    it("only auto-collapses resolved approvals with terminal statuses", () => {
        expect(shouldAutoCollapseResolvedApproval("pending")).toBe(false);
        expect(shouldAutoCollapseResolvedApproval("awaiting")).toBe(false);
        expect(shouldAutoCollapseResolvedApproval("applied")).toBe(true);
        expect(shouldAutoCollapseResolvedApproval("rejected")).toBe(true);
        expect(shouldAutoCollapseResolvedApproval("undone")).toBe(true);
        expect(shouldAutoCollapseResolvedApproval("error")).toBe(true);
        expect(shouldAutoCollapseResolvedApproval("applied", true)).toBe(false);
    });

    it("keeps a multi-action card pending until every action resolves", () => {
        const actions = [
            { status: "applied" },
            { status: "pending" },
        ] as any;

        expect(getActionCardResolutionStatus(actions, true, true)).toBe(
            "pending",
        );
    });

    it("treats a returned actionless confirmation as resolved", () => {
        expect(getActionCardResolutionStatus([], false, false)).toBe("pending");
        expect(getActionCardResolutionStatus([], false, true)).toBe("applied");
    });
});
