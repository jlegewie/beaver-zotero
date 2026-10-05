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
import type { AgentRun, ToolCallPart } from '@beaver/agent-core/agents/types';
import { citationByKeyAtom, citationMapAtom, citationsAtom } from '@beaver/agent-core/citations/atoms';
import {
    externalReferenceItemMappingAtom,
    externalReferenceMappingAtom,
} from '@beaver/agent-core/citations/externalReferences';
import { hydrateItemLinkLibraryRefs } from '@beaver/agent-core/identity/itemLinks';
import { buildExportSource, buildResponseBlocks, noteFromToolCall } from '@beaver/agent-export/source/buildSource';
import { buildCitationSnapshot } from '@beaver/agent-export/source/citationSnapshot';
import type { ExportContent, ExportSource, ExportSourceBlock } from '@beaver/agent-export/types';
import { mergeRunToolResults } from '@beaver/agent-core/run-state/atoms';
import { getToolCallLabel } from '@beaver/agent-core/run-state/toolLabels';
import { getToolCallResultView, resolveToolCallLabelEnrichMap } from './toolCallLabelEnrich';
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

/**
 * The thread-scoped state an export reads, captured in one synchronous step.
 * Export awaits (tool labels, page data); the reader may open another thread
 * meanwhile, and the export must still describe the thread it started from.
 */
function captureThreadState(runs: AgentRun[]) {
    return {
        title: responseExportTitle(runs, store.get(currentThreadNameAtom)),
        threadId: store.get(currentThreadIdAtom),
        citationContext: {
            citationDataMap: store.get(citationMapAtom),
            externalMapping: store.get(externalReferenceItemMappingAtom),
            externalReferencesMap: store.get(externalReferenceMappingAtom),
        },
    };
}

/** Capture the citation state the blocks need. */
async function citationSnapshotFor(
    blocks: ExportSourceBlock[],
    citationContext: ReturnType<typeof captureThreadState>['citationContext'],
) {
    const content = blocks.map(block => (block.type === 'activity' ? '' : block.markdown)).join('\n\n');
    const context = await prepareCitationRenderContext(content, citationContext);
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
 * Labels for the tool calls of a response, as the chat shows them: from each
 * call's result view and host-resolved names.
 */
async function toolCallDescriber(runs: AgentRun[]): Promise<(part: ToolCallPart) => string | null> {
    const toolResults = mergeRunToolResults(runs);
    const enrich = await resolveToolCallLabelEnrichMap(runs, toolResults);
    return (part) => {
        return getToolCallLabel(part, 'completed', {
            view: getToolCallResultView(part, toolResults),
            enrich: enrich.get(part.tool_call_id) ?? null,
        });
    };
}

/**
 * Export source for one response. `runs` is the response's resume chain (a
 * response continued after an error spans several runs). `content` picks the
 * final answer or the full response with its tool activity.
 */
export async function buildResponseExportSource(
    runs: AgentRun[],
    content: ExportContent = 'final',
): Promise<ExportSource> {
    const threadState = captureThreadState(runs);
    const describeToolCall = content === 'full' ? await toolCallDescriber(runs) : undefined;
    // Older history names libraries by device-local id; links must be portable.
    const blocks: ExportSourceBlock[] = buildResponseBlocks(runs, { content, describeToolCall }).map(block => (
        block.type === 'activity'
            ? block
            : { ...block, markdown: hydrateItemLinkLibraryRefs(block.markdown, libraryRefForLibraryID) }
    ));
    return buildExportSource({
        kind: 'response',
        title: threadState.title,
        blocks,
        citations: await citationSnapshotFor(blocks, threadState.citationContext),
        threadId: threadState.threadId,
        runIds: runs.map(run => run.id),
    });
}

/**
 * Export source for a note the agent wrote with `create_note`: the note's
 * title and markdown as the agent wrote them (with their citations), or null
 * when the run has no such call.
 */
export async function buildNoteExportSource(run: AgentRun, toolCallId: string): Promise<ExportSource | null> {
    const threadState = captureThreadState([run]);
    let note: { title: string; markdown: string } | null = null;
    for (const message of run.model_messages) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts) {
            if (part.part_kind === 'tool-call' && part.tool_call_id === toolCallId) note = noteFromToolCall(part);
        }
    }
    if (!note) return null;
    const blocks: ExportSourceBlock[] = [{
        type: 'markdown',
        markdown: hydrateItemLinkLibraryRefs(note.markdown, libraryRefForLibraryID),
    }];
    return buildExportSource({
        kind: 'note',
        title: note.title || 'Beaver note',
        blocks,
        citations: await citationSnapshotFor(blocks, threadState.citationContext),
        threadId: threadState.threadId,
        runIds: [run.id],
    });
}

