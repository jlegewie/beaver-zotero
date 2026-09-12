import { citationMapAtom } from '@beaver/agent-core/citations/atoms';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import type { OperationContext } from '../../src/services/agentDataProvider/operationContext';
import { currentThreadIdAtom } from '../atoms/threads';
import { store } from '../store';
import { prepareCitationRenderContext } from '../utils/citationRenderContext';
import { renderToHTML } from '../utils/citationRenderers';

/** Freeze manual note rendering inputs before queue admission and asynchronous reads. */
export function captureNoteOperationContext(): OperationContext {
    const renderContext = {
        citationDataMap: { ...store.get(citationMapAtom) },
        externalMapping: { ...store.get(externalReferenceItemMappingAtom) },
        externalReferencesMap: { ...store.get(externalReferenceMappingAtom) },
    };
    return {
        threadId: store.get(currentThreadIdAtom),
        externalRefs: renderContext.externalReferencesMap,
        externalItemMapping: renderContext.externalMapping,
        renderMarkdown: async content => renderToHTML(content, 'markdown',
            await prepareCitationRenderContext(content, renderContext)),
    };
}
