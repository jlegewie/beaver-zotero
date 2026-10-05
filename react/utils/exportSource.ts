/**
 * Build export sources from this window's run history and citation state.
 *
 * The data boundary of file export: everything the plugin-realm exporter
 * needs is captured here as plain data — the response's markdown blocks and
 * the citation metadata its tags look up, including page data resolved locally
 * for locators the backend metadata does not cover (the same context note
 * export uses).
 */

import { createStore } from 'jotai';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { citationByKeyAtom, citationMapAtom, citationsAtom } from '@beaver/agent-core/citations/atoms';
import {
    externalReferenceItemMappingAtom,
    externalReferenceMappingAtom,
} from '@beaver/agent-core/citations/externalReferences';
import { hydrateItemLinkLibraryRefs } from '@beaver/agent-core/identity/itemLinks';
import { buildExportSource, buildResponseBlocks } from '@beaver/agent-export/source/buildSource';
import { buildCitationSnapshot } from '@beaver/agent-export/source/citationSnapshot';
import type { ExportSource, ExportSourceBlock } from '@beaver/agent-export/types';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';
import { currentThreadIdAtom, currentThreadNameAtom } from '../atoms/threads';
import { store } from '../store';
import { prepareCitationRenderContext } from './citationRenderContext';

const MAX_TITLE_LENGTH = 80;

/** Title for an exported response: the thread's name, else the question that started it. */
export function responseExportTitle(runs: AgentRun[], threadName: string | null | undefined): string {
    if (threadName?.trim()) return threadName.trim();
    const prompt = runs[0]?.user_prompt?.content?.trim().split('\n')[0] ?? '';
    if (!prompt) return 'Beaver response';
    return prompt.length > MAX_TITLE_LENGTH ? `${prompt.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : prompt;
}

/** Capture the citation state the blocks need. */
async function citationSnapshotFor(blocks: ExportSourceBlock[]) {
    const content = blocks.map(block => block.markdown).join('\n\n');
    const context = await prepareCitationRenderContext(content, {
        citationDataMap: store.get(citationMapAtom),
        externalMapping: store.get(externalReferenceItemMappingAtom),
        externalReferencesMap: store.get(externalReferenceMappingAtom),
    });
    // Key the merged metadata exactly as the chat looks it up.
    const keyStore = createStore();
    keyStore.set(citationsAtom, Object.values(context?.citationDataMap ?? {}));
    return buildCitationSnapshot({
        blocks,
        citationsByKey: keyStore.get(citationByKeyAtom),
        externalReferences: context?.externalReferencesMap ?? {},
        externalItemMapping: context?.externalMapping ?? {},
        pageLabelsByAttachmentId: context?.pageLabelsByAttachmentId ?? {},
    });
}

/**
 * Export source for one response. `runs` is the response's resume chain (a
 * response continued after an error spans several runs).
 */
export async function buildResponseExportSource(runs: AgentRun[]): Promise<ExportSource> {
    // Older history names libraries by device-local id; links must be portable.
    const blocks = buildResponseBlocks(runs).map(block => ({
        ...block,
        markdown: hydrateItemLinkLibraryRefs(block.markdown, libraryRefForLibraryID),
    }));
    return buildExportSource({
        kind: 'response',
        title: responseExportTitle(runs, store.get(currentThreadNameAtom)),
        blocks,
        citations: await citationSnapshotFor(blocks),
        threadId: store.get(currentThreadIdAtom),
        runIds: runs.map(run => run.id),
    });
}
