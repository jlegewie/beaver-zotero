/**
 * Helper to emit an `attachment_resolved` ws event to the backend when a
 * background PDF fetch (scheduled by `applyCreateItemData` or `createZoteroItem`)
 * finishes. The backend uses this to:
 *   1) update `agent_actions.result_data.attachment_status` to terminal,
 *   2) queue an `<system-reminder>` injection for the next model request
 *      via the unified history processor.
 *
 * Dropped silently when the ws is not connected or when no `threadId` is
 * available; the backend safety-net lookup at the next user message handles
 * those cases via `lookup_zotero_data`.
 */

import { agentService } from '../../src/services/agentService';
import { logger } from '../../src/utils/logger';

export interface AttachmentResolvedPayload {
    threadId?: string;
    actionId?: string;
    libraryId: number;
    zoteroKey: string;
    attachmentStatus: 'available' | 'failed';
    attachmentKey?: string;
}

export function emitAttachmentResolved(payload: AttachmentResolvedPayload): void {
    if (!payload.threadId) return;
    if (!agentService.isConnected()) {
        logger(
            `emitAttachmentResolved: ws not connected; dropping event for ${payload.libraryId}-${payload.zoteroKey} (safety-net lookup will catch this)`,
            2,
        );
        return;
    }
    agentService.send({
        type: 'attachment_resolved',
        thread_id: payload.threadId,
        action_id: payload.actionId,
        library_id: payload.libraryId,
        zotero_key: payload.zoteroKey,
        attachment_status: payload.attachmentStatus,
        attachment_key: payload.attachmentKey,
    });
}
