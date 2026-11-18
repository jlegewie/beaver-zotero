import type { AttachmentResolvedPayload } from '../../src/services/attachmentResolved';
import { recordAttachmentResolutionAtom } from '../agents/agentActions';
import { store } from '../store';
import { emitAttachmentResolved } from '../utils/attachmentResolvedEvent';
import { tryGetWindowRuntime } from './windowRuntime';

/**
 * Completion carries its own thread/action identity and may outlive the originating run.
 * The outcome is also recorded on the action row this renderer shows, which the
 * backend does not echo back.
 */
export function captureAttachmentCompletion(): (payload: AttachmentResolvedPayload) => void {
    const runtime = tryGetWindowRuntime();
    const generation = Zotero.Beaver.account?.getGeneration();
    return payload => {
        if (runtime?.status !== 'closing' && generation === Zotero.Beaver.account?.getGeneration()) {
            emitAttachmentResolved(payload);
            store.set(recordAttachmentResolutionAtom, payload);
        }
    };
}
