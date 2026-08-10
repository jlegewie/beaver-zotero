import { describe, expect, it } from "vitest";

import {
    actionCardHasBrowsableCreatedArtifacts,
    actionCardOutcomeNeedsAttention,
    getActionLabel,
    getActionTitle,
    getActionCardExpansionTransition,
    getActionCardResolutionStatus,
    NEVER_AUTO_COLLAPSE_TOOLS,
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
    const expansionSignals = (overrides: Partial<{
        isAwaitingApproval: boolean;
        hasStoredPendingAction: boolean;
        resolutionStatus: "pending" | "awaiting" | "applied" | "rejected" | "undone" | "error";
        keepExpandedAfterResolution: boolean;
    }> = {}) => ({
        isAwaitingApproval: false,
        hasStoredPendingAction: false,
        resolutionStatus: "pending" as const,
        keepExpandedAfterResolution: false,
        ...overrides,
    });

    it("collapses only clean terminal outcomes", () => {
        expect(shouldAutoCollapseResolvedApproval("pending")).toBe(false);
        expect(shouldAutoCollapseResolvedApproval("awaiting")).toBe(false);
        expect(shouldAutoCollapseResolvedApproval("applied")).toBe(true);
        expect(shouldAutoCollapseResolvedApproval("rejected")).toBe(true);
        expect(shouldAutoCollapseResolvedApproval("undone")).toBe(true);
        expect(shouldAutoCollapseResolvedApproval("error")).toBe(false);
        expect(shouldAutoCollapseResolvedApproval("applied", true)).toBe(false);
        expect(shouldAutoCollapseResolvedApproval("applied", false, true)).toBe(false);
    });

    it("reserves permanent expansion for full Zotero note creation", () => {
        expect([...NEVER_AUTO_COLLAPSE_TOOLS]).toEqual(["create_note"]);
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

    it("opens when a stored pending action arrives after initialization", () => {
        expect(getActionCardExpansionTransition(
            expansionSignals(),
            expansionSignals({ hasStoredPendingAction: true }),
        )).toBe(true);
    });

    it("collapses when a stored pending mutation resolves cleanly", () => {
        expect(getActionCardExpansionTransition(
            expansionSignals({ hasStoredPendingAction: true }),
            expansionSignals({ resolutionStatus: "applied" }),
        )).toBe(false);
    });

    it("keeps a stored pending artifact result or error expanded", () => {
        expect(getActionCardExpansionTransition(
            expansionSignals({ hasStoredPendingAction: true }),
            expansionSignals({
                resolutionStatus: "applied",
                keepExpandedAfterResolution: true,
            }),
        )).toBe(true);
        expect(getActionCardExpansionTransition(
            expansionSignals({ hasStoredPendingAction: true }),
            expansionSignals({ resolutionStatus: "error" }),
        )).toBe(true);
    });

    it("preserves manual expansion when no lifecycle signal changed", () => {
        expect(getActionCardExpansionTransition(
            expansionSignals({ resolutionStatus: "applied" }),
            expansionSignals({ resolutionStatus: "applied" }),
        )).toBeNull();
    });

    it("treats a returned actionless confirmation as resolved", () => {
        expect(getActionCardResolutionStatus([], false, false)).toBe("pending");
        expect(getActionCardResolutionStatus([], false, true)).toBe("applied");
    });

    it("keeps partial annotation creation and skipped edits open", () => {
        const partialCreation = {
            status: "applied",
            action_type: "create_highlight_annotations",
            proposed_data: {},
            result_data: { created: [{}], failed: [{ error: "failed" }] },
        } as any;
        const skippedEdit = {
            status: "applied",
            action_type: "edit_annotations",
            proposed_data: {},
            result_data: { skipped: [{ annotation_id: "a", reason: "missing" }] },
        } as any;

        expect(actionCardOutcomeNeedsAttention([partialCreation])).toBe(true);
        expect(actionCardOutcomeNeedsAttention([skippedEdit])).toBe(true);
    });

    it("distinguishes clean annotation results from attention-required results", () => {
        const cleanCreation = {
            status: "applied",
            action_type: "create_note_annotations",
            proposed_data: {},
            result_data: { created: [{}], failed: [], total_failed: 0 },
        } as any;
        const cleanEdit = {
            status: "applied",
            action_type: "edit_annotations",
            proposed_data: {},
            result_data: { skipped: [] },
        } as any;

        expect(actionCardOutcomeNeedsAttention([cleanCreation])).toBe(false);
        expect(actionCardOutcomeNeedsAttention([cleanEdit])).toBe(false);
    });

    it.each([
        "create_note",
        "create_highlight_annotations",
        "create_note_annotations",
        "create_item",
        "create_collection",
    ])("keeps applied %s cards open as artifact browsers", (actionType) => {
        const action = {
            status: "applied",
            action_type: actionType,
            proposed_data: {},
            result_data: {},
        } as any;

        expect(actionCardHasBrowsableCreatedArtifacts([action])).toBe(true);
        expect(shouldAutoCollapseResolvedApproval("applied", false, true)).toBe(false);
    });

    it.each([
        "edit_annotations",
        "edit_metadata",
        "edit_note",
        "organize_items",
        "manage_tags",
        "manage_collections",
    ])("allows clean applied %s cards to collapse", (actionType) => {
        const action = {
            status: "applied",
            action_type: actionType,
            proposed_data: {},
            result_data: {},
        } as any;

        expect(actionCardHasBrowsableCreatedArtifacts([action])).toBe(false);
        expect(actionCardOutcomeNeedsAttention([action])).toBe(false);
    });

    it("does not retain rejected or undone creation cards as artifact browsers", () => {
        const creation = (status: "rejected" | "undone") => ({
            status,
            action_type: "create_collection",
            proposed_data: {},
        }) as any;

        expect(actionCardHasBrowsableCreatedArtifacts([creation("rejected")])).toBe(false);
        expect(actionCardHasBrowsableCreatedArtifacts([creation("undone")])).toBe(false);
    });

    it("does not keep rejected or undone actions open for recorded skips", () => {
        const skippedEdit = (status: "rejected" | "undone") => ({
            status,
            action_type: "edit_annotations",
            proposed_data: {
                skipped: [{ annotation_id: "a", reason: "missing" }],
            },
        }) as any;

        expect(actionCardOutcomeNeedsAttention([skippedEdit("rejected")])).toBe(false);
        expect(actionCardOutcomeNeedsAttention([skippedEdit("undone")])).toBe(false);
    });

    it("keeps mixed applied/error batches open", () => {
        const actions = [
            { status: "applied", action_type: "create_item", proposed_data: {} },
            { status: "error", action_type: "create_item", proposed_data: {} },
        ] as any;

        expect(getActionCardResolutionStatus(actions, true, true)).toBe("applied");
        expect(actionCardOutcomeNeedsAttention(actions)).toBe(true);
    });
});
