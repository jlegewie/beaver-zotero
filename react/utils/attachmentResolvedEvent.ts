import type { AttachmentResolvedPayload } from '../../src/services/attachmentResolved';
import { getSessionPort } from '../../src/services/agentRuns/runSession';
export type { AttachmentResolvedPayload } from '../../src/services/attachmentResolved';

/**
 * Report a resolved attachment to the backend on this window's run session
 * (see `src/services/agentRuns/attachmentResolvedEvent.ts`).
 */
export function emitAttachmentResolved(payload: AttachmentResolvedPayload): void {
    getSessionPort().emitAttachmentResolved(payload);
}
