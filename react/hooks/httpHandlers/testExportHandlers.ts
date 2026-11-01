/**
 * Dev-only window command behind `/beaver/test/export`: export a response of
 * the thread open in this window to a file, through the same source builder
 * and exporter the "Export to …" menu items use, without the save dialog.
 *
 * Request: `{ path, format?: 'docx' | 'pdf' | 'markdown' | 'latex', runId?,
 * scope?: 'response' | 'thread', content?: 'final' | 'full', styleId?, locale?,
 * liveCitations?, linkItems?, includeSource?, includeHtml?, frontMatter?,
 * citationPackage?, standalone? }`.
 * `runId` names any run of the response (default: the
 * thread's last run); the whole resume chain is exported. `scope: 'thread'`
 * exports the whole thread instead, as the chat menu's Export does. Returns the
 * exporter's result plus the exported run ids, and the source when
 * `includeSource` is set.
 */

import { allRunsAtom, resumeChainAtom } from '@beaver/agent-core/run-state/atoms';
import { store } from '../../store';
import { buildResponseExportSource, buildThreadExportSource } from '../../utils/exportSource';
import { getWindowRuntime } from '../../runtime/windowRuntime';

const EXPORT_FORMATS = ['docx', 'pdf', 'markdown', 'latex'];

export async function handleTestExportHttpRequest(request: any): Promise<any> {
    const runs = store.get(allRunsAtom);
    if (request?.scope === 'thread' && runs.length === 0) return { error: 'thread_empty' };
    const runId: string | undefined = typeof request?.runId === 'string' ? request.runId : runs[runs.length - 1]?.id;
    if (!runId || !runs.some(run => run.id === runId)) {
        return { error: 'run_not_found', runId: runId ?? null };
    }
    const chain = store.get(resumeChainAtom(runId));
    const content = request.content === 'full' ? 'full' : 'final';
    const source = request?.scope === 'thread'
        ? await buildThreadExportSource(runs)
        : await buildResponseExportSource(chain.length > 0 ? chain : runs.filter(run => run.id === runId), content);
    const result = await Zotero.Beaver.exporter.run({
        source,
        format: EXPORT_FORMATS.includes(request.format) ? request.format : 'docx',
        path: request.path,
        styleId: request.styleId,
        locale: request.locale,
        liveCitations: request.liveCitations,
        linkItems: request.linkItems,
        includeHtml: request.includeHtml,
        frontMatter: request.frontMatter,
        citationPackage: request.citationPackage,
        standalone: request.standalone,
    }, { windowId: getWindowRuntime().id });
    return {
        ...result,
        runIds: source.provenance.runIds,
        ...(request.includeSource ? { source } : {}),
    };
}
