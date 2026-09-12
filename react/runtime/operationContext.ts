import { citationMapAtom } from '@beaver/agent-core/citations/atoms';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import type { OperationContext } from '../../src/services/agentDataProvider/operationContext';
import { loadPreferences } from '../../src/services/deferredToolPolicy';
import { grantCreatedNoteEditsForRunAtom, isActionApprovedForCurrentRun, isFullAccessGrantedForRun, runApprovalPolicyAtom } from '../atoms/runApprovalPolicy';
import { currentThreadIdAtom } from '../atoms/threads';
import { store } from '../store';
import { captureAttachmentCompletion } from './attachmentCompletion';
import { prepareCitationRenderContext } from '../utils/citationRenderContext';
import { renderToHTML } from '../utils/citationRenderers';
import { tryGetWindowRuntime } from './windowRuntime';

/** Originless requests receive empty citation/grant state and an explicit render seam. */
export function captureOperationContext(local = false): OperationContext {
    const runtime = local ? tryGetWindowRuntime() : undefined;
    const runId = local ? store.get(activeRunAtom)?.id : undefined;
    const currentPolicy = local ? store.get(runApprovalPolicyAtom) : undefined;
    const policy = currentPolicy ? { ...currentPolicy, approvedResources: new Set(currentPolicy.approvedResources) } : undefined;
    const generation = Zotero.Beaver.account?.getGeneration();
    const renderContext = {
        citationDataMap: local ? { ...store.get(citationMapAtom) } : {},
        externalMapping: local ? { ...store.get(externalReferenceItemMappingAtom) } : {},
        externalReferencesMap: local ? { ...store.get(externalReferenceMappingAtom) } : {},
    };
    return {
        accountGeneration: generation,
        userId: Zotero.Beaver.account?.getSnapshot().session?.user.id,
        onAttachmentResolved: local ? captureAttachmentCompletion() : undefined,
        owner: runtime?.id,
        threadId: local ? store.get(currentThreadIdAtom) : null,
        runId,
        fullAccess: !!policy && isFullAccessGrantedForRun(policy, runId ?? null),
        preference: (tool, data) => {
            if (policy && isActionApprovedForCurrentRun(policy, runId ?? null, tool, data)) return 'always_apply';
            const prefs = loadPreferences();
            return prefs.groupPreferences[prefs.toolToGroup[tool] ?? tool] ?? 'always_ask';
        },
        externalRefs: renderContext.externalReferencesMap,
        externalItemMapping: renderContext.externalMapping,
        renderMarkdown: async content => renderToHTML(content, 'markdown',
            await prepareCitationRenderContext(content, renderContext)),
        grantCreatedNote: (libraryId, zoteroKey) => {
            if (runtime?.status !== 'closing' && runId && generation === Zotero.Beaver.account?.getGeneration() && store.get(activeRunAtom)?.id === runId) {
                store.set(grantCreatedNoteEditsForRunAtom, { runId, libraryId, zoteroKey });
            }
        },
    };
}
