import { atom } from 'jotai';
import type { AgentActionType } from '../../src/services/agentProtocol';

/**
 * Stable groups for actual deferred tool names. These seed persistent
 * preferences and are also recognized by transient run grants.
 *
 * Authorization invariant: run grants use this canonical map, not a persisted
 * toolToGroup remap. Runtime remapping is not currently supported; adding it
 * must update this policy boundary explicitly so stored preferences, pending
 * approval matching, labels, and run grants cannot silently diverge.
 */
export const DEFAULT_DEFERRED_TOOL_GROUPS: Record<string, string> = {
    edit_metadata: 'metadata_edits',
    edit_item: 'metadata_edits',
    edit_note: 'note_edits',
    create_note: 'note_creation',
    create_collection: 'library_modifications',
    organize_items: 'library_modifications',
    manage_tags: 'library_structure',
    manage_collections: 'library_structure',
    create_highlight_annotations: 'annotations',
    create_note_annotations: 'annotations',
    create_item: 'create_items',
    create_items: 'create_items',
};

/**
 * AgentAction aliases used only when authorizing or matching run approvals.
 * Keeping these out of DEFAULT_DEFERRED_TOOL_GROUPS prevents action-record
 * names from silently acquiring persistent preference defaults.
 */
export const RUN_APPROVAL_ACTION_TYPE_ALIASES: Record<string, string> = {
    zotero_note: 'note_creation',
    highlight_annotation: 'annotations',
    note_annotation: 'annotations',
};

const RUN_APPROVAL_TOOL_GROUPS: Record<string, string> = {
    ...DEFAULT_DEFERRED_TOOL_GROUPS,
    ...RUN_APPROVAL_ACTION_TYPE_ALIASES,
};

/** Labels complete the phrase "Allow all … for this run". */
export const TOOL_GROUP_RUN_LABELS: Record<string, string> = {
    metadata_edits: 'metadata edits',
    note_edits: 'note edits',
    note_creation: 'note creation',
    library_modifications: 'item organization and collection creation',
    library_structure: 'library-wide tag and collection changes',
    annotations: 'annotation creation',
    create_items: 'item creation',
};

export function getToolGroup(toolName: string): string | null {
    return RUN_APPROVAL_TOOL_GROUPS[toolName] ?? null;
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

export interface RunApprovalPolicy {
    /** The single active agent run. A new run grant replaces stale state. */
    runId: string | null;
    approvedGroups: Set<string>;
    /** Narrow grants derived from resources created during this run. */
    approvedResources: Set<string>;
}

function emptyRunApprovalPolicy(): RunApprovalPolicy {
    return {
        runId: null,
        approvedGroups: new Set<string>(),
        approvedResources: new Set<string>(),
    };
}

function policyForRun(previous: RunApprovalPolicy, runId: string): RunApprovalPolicy {
    if (previous.runId !== runId) {
        return {
            runId,
            approvedGroups: new Set<string>(),
            approvedResources: new Set<string>(),
        };
    }
    return {
        runId,
        approvedGroups: new Set(previous.approvedGroups),
        approvedResources: new Set(previous.approvedResources),
    };
}

function noteEditResourceKey(libraryId: number, zoteroKey: string): string {
    return `note_edits:${libraryId}-${zoteroKey}`;
}

function getNoteEditTarget(actionData?: Record<string, any>): {
    libraryId: number;
    zoteroKey: string;
} | null {
    const libraryId = actionData?.library_id;
    const zoteroKey = actionData?.zotero_key;
    return typeof libraryId === 'number' && Number.isFinite(libraryId) && typeof zoteroKey === 'string' && zoteroKey
        ? { libraryId, zoteroKey }
        : null;
}

/** Transient approval grants for the active run. Never persisted to prefs. */
export const runApprovalPolicyAtom = atom<RunApprovalPolicy>(emptyRunApprovalPolicy());

export const grantToolGroupForRunAtom = atom(
    null,
    (_get, set, { runId, toolName }: { runId: string; toolName: string }) => {
        const group = getToolGroup(toolName);
        if (!group) return;

        set(runApprovalPolicyAtom, (previous) => {
            const next = policyForRun(previous, runId);
            next.approvedGroups.add(group);
            return next;
        });
    },
);

/**
 * Allow edits to a note Beaver created during this run without granting the
 * broader note_edits group.
 */
export const grantCreatedNoteEditsForRunAtom = atom(
    null,
    (
        _get,
        set,
        { runId, libraryId, zoteroKey }: {
            runId: string;
            libraryId: number;
            zoteroKey: string;
        },
    ) => {
        set(runApprovalPolicyAtom, (previous) => {
            const next = policyForRun(previous, runId);
            next.approvedResources.add(noteEditResourceKey(libraryId, zoteroKey));
            return next;
        });
    },
);

export const clearRunApprovalPolicyAtom = atom(null, (_get, set) => {
    set(runApprovalPolicyAtom, emptyRunApprovalPolicy());
});

export function isToolGroupApprovedForRun(
    policy: RunApprovalPolicy,
    runId: string,
    toolName: string,
): boolean {
    if (policy.runId !== runId) return false;
    const group = getToolGroup(toolName);
    return group !== null && policy.approvedGroups.has(group);
}

export function isActionApprovedForRun(
    policy: RunApprovalPolicy,
    runId: string,
    toolName: AgentActionType | string,
    actionData?: Record<string, any>,
): boolean {
    if (policy.runId !== runId) return false;
    if (isToolGroupApprovedForRun(policy, runId, toolName)) return true;
    if (toolName !== 'edit_note') return false;
    const target = getNoteEditTarget(actionData);
    return target !== null && policy.approvedResources.has(
        noteEditResourceKey(target.libraryId, target.zoteroKey),
    );
}

/**
 * Validation requests do not currently include run_id. There is only one live
 * agent WebSocket, so lifecycle cleanup makes the stored policy the active run.
 */
export function isActionApprovedForCurrentRun(
    policy: RunApprovalPolicy,
    toolName: AgentActionType | string,
    actionData?: Record<string, any>,
): boolean {
    return policy.runId !== null && isActionApprovedForRun(
        policy,
        policy.runId,
        toolName,
        actionData,
    );
}
