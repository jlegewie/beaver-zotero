import type { AttachmentResolvedPayload } from '../../src/services/attachmentResolved';
export type { AttachmentResolvedPayload } from '../../src/services/attachmentResolved';
/**
 * Helper to emit an `attachment_resolved` ws event to the backend when a
 * background PDF fetch (scheduled by `applyCreateItemData` or `createZoteroItem`)
 * finishes. While the `create_items` call that created the item is still
 * open, the backend folds the outcome into that call's result; later outcomes
 * are not reported to the model.
 *
 * Dropped silently when the ws is not connected or when no `threadId` is
 * available.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { agentService } from '@beaver/agent-core/transport/agentService';

import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';


export function emitAttachmentResolved(payload: AttachmentResolvedPayload): void {
    if (!payload.threadId) return;
    if (!agentService.isConnected()) {
        logger(
            `emitAttachmentResolved: ws not connected; dropping event for ${payload.libraryId}-${payload.zoteroKey}`,
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
        library_ref: libraryRefForLibraryID(payload.libraryId) ?? undefined,
        attachment_status: payload.attachmentStatus,
        attachment_key: payload.attachmentKey,
        access_method: payload.accessMethod,
        elapsed_ms: payload.elapsedMs,
        failure_reason: payload.failureReason,
        attempts: payload.attempts?.length
            ? payload.attempts.map((attempt) => ({
                access_method: attempt.accessMethod,
                host: attempt.host,
                outcome: attempt.outcome,
                status: attempt.status,
            }))
            : undefined,
    });
}
