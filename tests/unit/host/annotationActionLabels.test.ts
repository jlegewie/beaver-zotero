import { describe, expect, it } from "vitest";

import {
    getActionLabel,
    getActionTitle,
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
});
