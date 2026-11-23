import { citationMapAtom } from '@beaver/agent-core/citations/atoms';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import type { OperationContext } from '../../src/services/agentDataProvider/operationContext';
import { currentThreadIdAtom } from '../atoms/threads';
import { store } from '../store';
import { renderNoteMarkdownToHTML } from '../utils/noteMarkdownRender';

/**
 * Freeze manual note rendering inputs before queue admission and asynchronous reads.
 * `threadId` is the thread that owns the action's run, which the note's Beaver
 * footer links to; without it, the thread in view is used.
 */
export function captureNoteOperationContext(threadId?: string): OperationContext {
    const renderContext = {
        citationDataMap: { ...store.get(citationMapAtom) },
        externalMapping: { ...store.get(externalReferenceItemMappingAtom) },
        externalReferencesMap: { ...store.get(externalReferenceMappingAtom) },
    };
    return {
        threadId: threadId ?? store.get(currentThreadIdAtom),
        externalRefs: renderContext.externalReferencesMap,
        externalItemMapping: renderContext.externalMapping,
        renderMarkdown: content => renderNoteMarkdownToHTML(content, renderContext),
    };
}
