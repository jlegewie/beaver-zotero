import { ToolCallPart } from '../../agents/types';
import type { ToolCallStatus } from '../../agents/atoms';
import type { AgentAction, PendingApproval } from '../../agents/agentActions';
import { isAnnotationToolResult } from '../../agents/toolResultTypes';

export interface EditNoteResolvedTarget {
    libraryId: number;
    zoteroKey: string;
}

export type EditNoteDisplayStatus =
    | 'awaiting'
    | 'pending'
    | 'applied'
    | 'rejected'
    | 'undone'
    | 'error';

export type EditNoteTarget =
    | { kind: 'known'; libraryId: number; zoteroKey: string }
    | { kind: 'pending' }
    | null;

export type EditNoteRenderItem =
    | { kind: 'single'; part: ToolCallPart }
    | {
        kind: 'edit-note-group';
        parts: ToolCallPart[];
        target: EditNoteResolvedTarget | null;
    };

export function getEditNoteGroupInstanceId(parts: ToolCallPart[]): string {
    return parts[0]?.tool_call_id ?? 'unknown';
}

export function getEditNoteGroupExpansionKey(
    runId: string,
    responseIndex: number,
    parts: ToolCallPart[],
): string {
    return `${runId}:${responseIndex}:group:${getEditNoteGroupInstanceId(parts)}`;
}

/**
 * Best-effort parse of a tool-call `args` payload into an object.
 */
export function parseEditNoteToolCallArgs(
    args: ToolCallPart['args'] | Record<string, any> | null | undefined,
): Record<string, any> | null {
    if (args == null) return null;
    if (typeof args !== 'string') {
        return typeof args === 'object' ? args as Record<string, any> : null;
    }
    if (!args) return null;
    try {
        const parsed = JSON.parse(args);
        return parsed && typeof parsed === 'object'
            ? parsed as Record<string, any>
            : null;
    } catch {
        return null;
    }
}

/**
 * Resolve an edit_note target from note_id or library_id/zotero_key.
 */
export function resolveEditNoteTargetFromData(
    args: ToolCallPart['args'] | Record<string, any> | null | undefined,
): EditNoteResolvedTarget | null {
    const parsedArgs = parseEditNoteToolCallArgs(args);
    if (!parsedArgs) return null;

    const noteId = parsedArgs.note_id;
    if (typeof noteId === 'string' && noteId) {
        const dashIdx = noteId.indexOf('-');
        if (dashIdx > 0 && dashIdx < noteId.length - 1) {
            const libraryId = parseInt(noteId.substring(0, dashIdx), 10);
            const zoteroKey = noteId.substring(dashIdx + 1);
            if (Number.isFinite(libraryId) && zoteroKey) {
                return { libraryId, zoteroKey };
            }
        }
    }

    const libRaw = parsedArgs.library_id;
    const keyRaw = parsedArgs.zotero_key;
    const libraryId = typeof libRaw === 'number'
        ? libRaw
        : (typeof libRaw === 'string' ? parseInt(libRaw, 10) : NaN);
    if (Number.isFinite(libraryId) && typeof keyRaw === 'string' && keyRaw) {
        return { libraryId, zoteroKey: keyRaw };
    }

    return null;
}

export function findPendingApprovalForToolcall(
    toolcallId: string,
    pendingApprovals: Iterable<PendingApproval>,
): PendingApproval | null {
    for (const pending of pendingApprovals) {
        if (pending.toolcallId === toolcallId) {
            return pending;
        }
    }
    return null;
}

export function getEffectiveEditNotePendingApproval(
    action: Pick<AgentAction, 'status'> | null | undefined,
    pendingApproval: PendingApproval | null | undefined,
): PendingApproval | null {
    const actionInFinalState = action && action.status !== 'pending';
    return actionInFinalState ? null : (pendingApproval ?? null);
}

export function getEditNoteDisplayStatus({
    action,
    pendingApproval,
    toolCallStatus,
}: {
    action: Pick<AgentAction, 'status'> | null | undefined;
    pendingApproval: PendingApproval | null | undefined;
    toolCallStatus: ToolCallStatus;
}): EditNoteDisplayStatus {
    if (pendingApproval) return 'awaiting';
    if (action) return action.status;
    if (toolCallStatus === 'error') return 'error';
    return 'pending';
}

export function isEditNoteStreamingPlaceholder({
    action,
    pendingApproval,
    toolCallStatus,
}: {
    action: Pick<AgentAction, 'status'> | null | undefined;
    pendingApproval: PendingApproval | null | undefined;
    toolCallStatus: ToolCallStatus;
}): boolean {
    return !action && !pendingApproval && toolCallStatus === 'in_progress';
}

export function isEditNoteOrphaned({
    action,
    pendingApproval,
    toolCallStatus,
}: {
    action: Pick<AgentAction, 'status'> | null | undefined;
    pendingApproval: PendingApproval | null | undefined;
    toolCallStatus: ToolCallStatus;
}): boolean {
    return !action && !pendingApproval && toolCallStatus === 'error';
}

export function getOverallEditNoteDisplayStatus(
    statuses: EditNoteDisplayStatus[],
): EditNoteDisplayStatus {
    if (statuses.length === 0) return 'pending';
    if (statuses.includes('awaiting')) return 'awaiting';
    if (statuses.includes('pending')) return 'pending';
    if (statuses.includes('applied')) return 'applied';
    if (statuses.includes('error')) return 'error';
    if (statuses.every((status) => status === 'rejected' || status === 'undone')) {
        return 'rejected';
    }
    return 'pending';
}

/**
 * Inspect a tool-call part and decide how it participates in an edit_note run.
 */
export function getEditNoteTarget(part: ToolCallPart): EditNoteTarget {
    if (part.tool_name !== 'edit_note') return null;
    if (isAnnotationToolResult(part.tool_name)) return null;

    const target = resolveEditNoteTargetFromData(part.streaming_args)
        ?? resolveEditNoteTargetFromData(part.args);
    if (target) {
        return { kind: 'known', ...target };
    }

    return { kind: 'pending' };
}

/**
 * Fold consecutive edit_note parts into a single container item. Unlike the
 * original branch logic, single edit_note calls are grouped too so all note
 * edits render through EditNoteGroupView.
 */
export function buildEditNoteRenderItems(parts: ToolCallPart[]): EditNoteRenderItem[] {
    const items: EditNoteRenderItem[] = [];
    let runParts: ToolCallPart[] = [];
    let runTarget: EditNoteResolvedTarget | null = null;

    const flushRun = () => {
        if (runParts.length === 0) return;
        items.push({
            kind: 'edit-note-group',
            parts: runParts,
            target: runTarget,
        });
        runParts = [];
        runTarget = null;
    };

    for (const part of parts) {
        const target = getEditNoteTarget(part);
        if (target?.kind === 'known') {
            if (runParts.length === 0) {
                runParts = [part];
                runTarget = {
                    libraryId: target.libraryId,
                    zoteroKey: target.zoteroKey,
                };
            } else if (
                runTarget === null
                || (
                    runTarget.libraryId === target.libraryId
                    && runTarget.zoteroKey === target.zoteroKey
                )
            ) {
                runParts.push(part);
                runTarget = runTarget ?? {
                    libraryId: target.libraryId,
                    zoteroKey: target.zoteroKey,
                };
            } else {
                flushRun();
                runParts = [part];
                runTarget = {
                    libraryId: target.libraryId,
                    zoteroKey: target.zoteroKey,
                };
            }
        } else if (target?.kind === 'pending') {
            runParts.push(part);
        } else {
            flushRun();
            items.push({ kind: 'single', part });
        }
    }

    flushRun();
    return items;
}
