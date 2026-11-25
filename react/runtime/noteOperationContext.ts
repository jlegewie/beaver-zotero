import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import type { OperationContext } from '../../src/services/agentDataProvider/operationContext';
import { currentThreadIdAtom } from '../atoms/threads';
import { store } from '../store';

/**
 * Freeze manual note write inputs before queue admission and asynchronous reads.
 * `threadId` is the thread that owns the action's run, which the note's Beaver
 * footer links to; without it, the thread in view is used.
 */
export function captureNoteOperationContext(threadId?: string): OperationContext {
    return {
        threadId: threadId ?? store.get(currentThreadIdAtom),
        externalRefs: { ...store.get(externalReferenceMappingAtom) },
        externalItemMapping: { ...store.get(externalReferenceItemMappingAtom) },
    };
}
