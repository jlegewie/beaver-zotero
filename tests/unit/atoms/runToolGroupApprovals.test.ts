import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import {
  clearRunToolGroupApprovalsAtom,
  getToolGroup,
  getToolGroupRunApprovalLabel,
  getPendingApprovalIdsForToolGroup,
  grantToolGroupForRunAtom,
  isToolGroupApprovedForCurrentRun,
  isToolGroupApprovedForRun,
  runToolGroupApprovalsAtom,
} from "../../../react/atoms/runToolGroupApprovals";

describe("runToolGroupApprovals", () => {
  it("shares a run grant across tools in the same user-facing group", () => {
    const store = createStore();

    store.set(grantToolGroupForRunAtom, {
      runId: "run-1",
      toolName: "edit_metadata",
    });

    const approvals = store.get(runToolGroupApprovalsAtom);
    expect(isToolGroupApprovedForRun(approvals, "run-1", "edit_metadata")).toBe(
      true,
    );
    expect(isToolGroupApprovedForRun(approvals, "run-1", "edit_item")).toBe(
      true,
    );
    expect(isToolGroupApprovedForRun(approvals, "run-1", "edit_note")).toBe(
      false,
    );
    expect(isToolGroupApprovedForRun(approvals, "run-2", "edit_metadata")).toBe(
      false,
    );
  });

  it("replaces stale grants when a different run receives a grant", () => {
    const store = createStore();
    store.set(grantToolGroupForRunAtom, {
      runId: "run-1",
      toolName: "edit_metadata",
    });
    store.set(grantToolGroupForRunAtom, {
      runId: "run-2",
      toolName: "edit_note",
    });

    const approvals = store.get(runToolGroupApprovalsAtom);
    expect(approvals.runId).toBe("run-2");
    expect(isToolGroupApprovedForCurrentRun(approvals, "edit_note")).toBe(true);
    expect(isToolGroupApprovedForCurrentRun(approvals, "edit_metadata")).toBe(
      false,
    );
  });

  it("clears every grant at the run lifecycle boundary", () => {
    const store = createStore();
    store.set(grantToolGroupForRunAtom, {
      runId: "run-1",
      toolName: "manage_tags",
    });

    store.set(clearRunToolGroupApprovalsAtom);

    const approvals = store.get(runToolGroupApprovalsAtom);
    expect(approvals.runId).toBeNull();
    expect(approvals.approvedGroups.size).toBe(0);
  });

  it("does not offer action-group grants for cost confirmations", () => {
    expect(getToolGroup("confirm_extraction")).toBeNull();
    expect(getToolGroup("confirm_external_search")).toBeNull();
    expect(getToolGroupRunApprovalLabel("confirm_extraction")).toBeNull();
  });

  it("selects all currently pending approvals in the group and no others", () => {
    const pending = [
      { actionId: "metadata-1", actionType: "edit_metadata" },
      { actionId: "metadata-2", actionType: "edit_item" },
      { actionId: "note-1", actionType: "edit_note" },
    ];

    expect(getPendingApprovalIdsForToolGroup(pending, "edit_metadata")).toEqual(
      ["metadata-1", "metadata-2"],
    );
  });

  it("uses explicit run-scoped labels", () => {
    expect(getToolGroupRunApprovalLabel("edit_note")).toBe(
      "Allow all note edits for this run",
    );
    expect(getToolGroupRunApprovalLabel("manage_collections")).toBe(
      "Allow all tag and collection changes for this run",
    );
  });
});
