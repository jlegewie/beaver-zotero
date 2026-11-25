import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import type { OperationContext } from '../../src/services/agentDataProvider/operationContext';
import { loadPreferences } from '../../src/services/deferredToolPolicy';
import { grantCreatedNoteEditsForRunAtom, isActionApprovedForCurrentRun, isFullAccessGrantedForRun, runApprovalPolicyAtom } from '../../src/services/agentRuns/runApprovalPolicy';
import { currentThreadIdAtom } from '../atoms/threads';
import { store } from '../store';
import { captureAttachmentCompletion } from './attachmentCompletion';
import { tryGetWindowRuntime } from './windowRuntime';
import { runSessionStore } from '../../src/services/agentRuns/runSession';

/** Originless requests receive empty citation/grant state; Markdown renders in the plugin realm. */
export function captureOperationContext(local = false): OperationContext {
    const runtime = local ? tryGetWindowRuntime() : undefined;
    const runId = local ? store.get(activeRunAtom)?.id : undefined;
    const currentPolicy = local ? store.get(runApprovalPolicyAtom) : undefined;
    const policy = currentPolicy ? { ...currentPolicy, approvedResources: new Set(currentPolicy.approvedResources) } : undefined;
    const generation = Zotero.Beaver.account?.getGeneration();
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
        externalRefs: local ? { ...store.get(externalReferenceMappingAtom) } : {},
        externalItemMapping: local ? { ...store.get(externalReferenceItemMappingAtom) } : {},
        renderMarkdown: async (content, options) => Zotero.Beaver.exporter.renderNoteMarkdown(content, options),
        grantCreatedNote: (libraryId, zoteroKey) => {
            if (runtime?.status !== 'closing' && runId && generation === Zotero.Beaver.account?.getGeneration() && store.get(activeRunAtom)?.id === runId) {
                runSessionStore().set(grantCreatedNoteEditsForRunAtom, { runId, libraryId, zoteroKey });
            }
        },
    };
}
