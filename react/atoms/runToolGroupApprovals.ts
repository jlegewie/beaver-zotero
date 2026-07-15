import { atom } from "jotai";
import type { AgentActionType } from "../../src/services/agentProtocol";

/**
 * Stable approval groups shared by persistent defaults and transient run grants.
 * Tool aliases deliberately map to the same group so an approval follows the
 * user-facing capability rather than a backend implementation name.
 */
export const DEFAULT_TOOL_GROUPS: Record<string, string> = {
  edit_metadata: "metadata_edits",
  edit_item: "metadata_edits",
  edit_note: "note_edits",
  create_note: "note_creation",
  zotero_note: "note_creation",
  create_collection: "library_modifications",
  organize_items: "library_modifications",
  manage_tags: "library_structure",
  manage_collections: "library_structure",
  highlight_annotation: "annotations",
  note_annotation: "annotations",
  create_highlight_annotations: "annotations",
  create_note_annotations: "annotations",
  create_item: "create_items",
  create_items: "create_items",
};

/** Labels complete the phrase "Allow all … for this run". */
export const TOOL_GROUP_RUN_LABELS: Record<string, string> = {
  metadata_edits: "metadata edits",
  note_edits: "note edits",
  note_creation: "note creation",
  library_modifications: "library organization changes",
  library_structure: "tag and collection changes",
  annotations: "annotation creation",
  create_items: "item creation",
};

export function getToolGroup(toolName: string): string | null {
  return DEFAULT_TOOL_GROUPS[toolName] ?? null;
}

export function getToolGroupRunApprovalLabel(toolName: string): string | null {
  const group = getToolGroup(toolName);
  if (!group) return null;
  const label = TOOL_GROUP_RUN_LABELS[group];
  return label ? `Allow all ${label} for this run` : null;
}

export function getPendingApprovalIdsForToolGroup(
  approvals: Iterable<{ actionId: string; actionType: string }>,
  toolName: string,
): string[] {
  const group = getToolGroup(toolName);
  if (!group) return [];
  const ids: string[] = [];
  for (const approval of approvals) {
    if (getToolGroup(approval.actionType) === group) {
      ids.push(approval.actionId);
    }
  }
  return ids;
}

export interface RunToolGroupApprovals {
  /** The single active agent run. A new run grant replaces stale state. */
  runId: string | null;
  approvedGroups: Set<string>;
}

const EMPTY_RUN_APPROVALS: RunToolGroupApprovals = {
  runId: null,
  approvedGroups: new Set<string>(),
};

/** Transient approval grants for the active run. Never persisted to prefs. */
export const runToolGroupApprovalsAtom =
  atom<RunToolGroupApprovals>(EMPTY_RUN_APPROVALS);

export const grantToolGroupForRunAtom = atom(
  null,
  (_get, set, { runId, toolName }: { runId: string; toolName: string }) => {
    const group = getToolGroup(toolName);
    if (!group) return;

    set(runToolGroupApprovalsAtom, (previous) => {
      const approvedGroups =
        previous.runId === runId
          ? new Set(previous.approvedGroups)
          : new Set<string>();
      approvedGroups.add(group);
      return { runId, approvedGroups };
    });
  },
);

export const clearRunToolGroupApprovalsAtom = atom(null, (_get, set) => {
  set(runToolGroupApprovalsAtom, {
    runId: null,
    approvedGroups: new Set<string>(),
  });
});

export function isToolGroupApprovedForRun(
  approvals: RunToolGroupApprovals,
  runId: string,
  toolName: string,
): boolean {
  if (approvals.runId !== runId) return false;
  const group = getToolGroup(toolName);
  return group !== null && approvals.approvedGroups.has(group);
}

/**
 * Validation requests do not currently include run_id. There is only one live
 * agent WebSocket, so lifecycle cleanup makes the stored policy the active run.
 */
export function isToolGroupApprovedForCurrentRun(
  approvals: RunToolGroupApprovals,
  toolName: AgentActionType | string,
): boolean {
  if (!approvals.runId) return false;
  const group = getToolGroup(toolName);
  return group !== null && approvals.approvedGroups.has(group);
}
