import { atom } from 'jotai';
import type { AgentActionType } from '@beaver/agent-core/protocol/agentProtocol';

/**
 * Stable groups for actual deferred tool names. These seed persistent
 * preferences and are also recognized by transient run grants.
 *
 * Authorization invariant: run grants use this canonical map, not a persisted
 * toolToGroup remap. Runtime remapping is not currently supported; adding it
 * must update this policy boundary explicitly so stored preferences, pending
 * approval matching, and run grants cannot silently diverge.
 */
export const DEFAULT_DEFERRED_TOOL_GROUPS: Record<string, string> = {
    edit_metadata: 'metadata_edits',
    edit_item: 'metadata_edits',
    edit_note: 'note_edits',
    edit_note_batch: 'note_edits',
    // A rewrite that discards or replaces most of a note gets its own group, so
    // approving note edits never carries one with it. Classification happens in
    // validation (see noteRewriteRisk.ts) — it is the only step holding both the
    // live note and the payload — and rides along on the action data as
    // `destructive_rewrite` so later approval steps, which only ever see the
    // `edit_note_batch` action type, classify it the same way. Like annotation
    // deletion this has no Preferences row on purpose: with nothing to persist a
    // preference against it always resolves to `always_ask`, so "apply note
    // edits automatically" cannot reach it.
    destructive_note_rewrite: 'note_rewrite',
    create_note: 'note_creation',
    create_collection: 'library_modifications',
    organize_items: 'library_modifications',
    manage_tags: 'library_structure',
    manage_collections: 'library_structure',
    create_highlight_annotations: 'annotations',
    create_note_annotations: 'annotations',
    edit_annotations: 'annotations',
    // Deletion is its own group so approving annotation edits never carries
    // deletions with it. It has no editable Preferences row on purpose, so the
    // normal UI always asks unless the user grants deletion for the current
    // run. A manually configured underlying group preference is still read.
    delete_annotations: 'annotation_deletion',
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

export function getToolGroup(toolName: string): string | null {
    return RUN_APPROVAL_TOOL_GROUPS[toolName] ?? null;
}

/**
 * True when this action is a whole-note rewrite that validation classified as
 * destructive. The wire action type stays `edit_note_batch`, so the flag
 * validation persists in the action data is the only thing separating it from
 * an ordinary note edit on the approval side.
 */
export function isDestructiveNoteRewriteAction(
    actionType: string,
    actionData?: Record<string, any>,
): boolean {
    return actionType === 'edit_note_batch' && actionData?.destructive_rewrite === true;
}

/**
 * Resolve the authorization group for an action record.
 *
 * Two wire action types are shared by tools with different blast radii, so
 * authorization must read the payload as well as the action type:
 * - edit_annotations is emitted by delete_annotations with operation=delete.
 * - edit_note_batch is emitted for a destructive whole-note rewrite.
 * Classifying on the action type alone would let the narrower group's grant be
 * satisfied by an ordinary edit grant.
 */
export function getActionToolGroup(
    actionType: string,
    actionData?: Record<string, any>,
): string | null {
    if (
        actionType === 'edit_annotations' &&
        actionData?.operation === 'delete'
    ) {
        return getToolGroup('delete_annotations');
    }
    if (isDestructiveNoteRewriteAction(actionType, actionData)) {
        return getToolGroup('destructive_note_rewrite');
    }
    return getToolGroup(actionType);
}

/**
 * Whether a full-access run grant covers this action.
 *
 * The grant is about library writes, so it reaches exactly the actions that
 * have a deferred-tool group. Everything else — the backend-managed
 * `confirm_extraction` / `confirm_external_search` cards, which are about
 * spend and off-device access rather than the library — keeps asking, and so
 * does any future write tool until it is given a group here.
 */
export function isCoveredByFullAccess(
    actionType: string,
    actionData?: Record<string, any>,
): boolean {
    return getActionToolGroup(actionType, actionData) !== null;
}

/** The pending approvals a full-access grant may answer on the user's behalf. */
export function getPendingApprovalIdsCoveredByFullAccess(
    approvals: Iterable<{
        actionId: string;
        actionType: string;
        actionData?: Record<string, any>;
    }>,
): string[] {
    const ids: string[] = [];
    for (const approval of approvals) {
        if (isCoveredByFullAccess(approval.actionType, approval.actionData)) {
            ids.push(approval.actionId);
        }
    }
    return ids;
}

export interface RunApprovalPolicy {
    /** The single active agent run. A new run grant replaces stale state. */
    runId: string | null;
    /**
     * Full access for this run: every library change applies without asking,
     * with no carve-outs among the write tools (see `isCoveredByFullAccess`).
     */
    fullAccess: boolean;
    /** Narrow grants derived from resources created during this run. */
    approvedResources: Set<string>;
}

function emptyRunApprovalPolicy(): RunApprovalPolicy {
    return {
        runId: null,
        fullAccess: false,
        approvedResources: new Set<string>(),
    };
}

function policyForRun(previous: RunApprovalPolicy, runId: string): RunApprovalPolicy {
    if (previous.runId !== runId) {
        return {
            runId,
            fullAccess: false,
            approvedResources: new Set<string>(),
        };
    }
    return {
        runId,
        fullAccess: previous.fullAccess,
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

/**
 * Turn full access on or off for a run.
 *
 * Granting is scoped to the run that is asking: a grant made against a run that
 * is no longer current cannot leak into the next one, because `policyForRun`
 * discards state from a different run.
 */
export const setRunFullAccessAtom = atom(
    null,
    (_get, set, { runId, fullAccess }: { runId: string; fullAccess: boolean }) => {
        set(runApprovalPolicyAtom, (previous) => {
            const next = policyForRun(previous, runId);
            next.fullAccess = fullAccess;
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

/** Whether this run currently holds the full-access grant. */
export function isFullAccessGrantedForRun(
    policy: RunApprovalPolicy,
    runId: string | null,
): boolean {
    return runId !== null && policy.runId === runId && policy.fullAccess;
}

export function isActionApprovedForRun(
    policy: RunApprovalPolicy,
    runId: string,
    toolName: AgentActionType | string,
    actionData?: Record<string, any>,
): boolean {
    if (policy.runId !== runId) return false;
    if (policy.fullAccess && isCoveredByFullAccess(toolName, actionData)) return true;
    // The resource grant covers destructive rewrites too: it is only ever
    // granted for a note Beaver created during this same run, so a rewrite of
    // one can discard nothing the user wrote.
    if (
        toolName !== 'edit_note'
        && toolName !== 'edit_note_batch'
        && toolName !== 'destructive_note_rewrite'
    ) return false;
    const target = getNoteEditTarget(actionData);
    return target !== null && policy.approvedResources.has(
        noteEditResourceKey(target.libraryId, target.zoteroKey),
    );
}

/**
 * Validation requests do not currently include run_id, so callers must provide
 * the actual active run ID. Comparing it separately prevents a late async grant
 * from making stale policy state look current after a run boundary.
 */
export function isActionApprovedForCurrentRun(
    policy: RunApprovalPolicy,
    activeRunId: string | null,
    toolName: AgentActionType | string,
    actionData?: Record<string, any>,
): boolean {
    return activeRunId !== null && isActionApprovedForRun(
        policy,
        activeRunId,
        toolName,
        actionData,
    );
}
