/**
 * Dev-only window command behind `/beaver/test/export`: export a response of
 * the thread open in this window to a file, through the same source builder
 * and exporter the "Export to Word…" menu uses, without the save dialog.
 *
 * Request: `{ path, runId?, styleId?, locale?, liveCitations?, linkItems?,
 * includeSource? }`. `runId` names any run of the response (default: the
 * thread's last run); the whole resume chain is exported. Returns the
 * exporter's result plus the exported run ids, and the source when
 * `includeSource` is set.
 */

import { allRunsAtom, resumeChainAtom } from '@beaver/agent-core/run-state/atoms';
import { store } from '../../store';
import { buildResponseExportSource } from '../../utils/exportSource';
import { getWindowRuntime } from '../../runtime/windowRuntime';

export async function handleTestExportHttpRequest(request: any): Promise<any> {
    const runs = store.get(allRunsAtom);
    const runId: string | undefined = typeof request?.runId === 'string' ? request.runId : runs[runs.length - 1]?.id;
    if (!runId || !runs.some(run => run.id === runId)) {
        return { error: 'run_not_found', runId: runId ?? null };
    }
    const chain = store.get(resumeChainAtom(runId));
    const source = await buildResponseExportSource(chain.length > 0 ? chain : runs.filter(run => run.id === runId));
    const result = await Zotero.Beaver.exporter.run({
        source,
        format: 'docx',
        path: request.path,
        styleId: request.styleId,
        locale: request.locale,
        liveCitations: request.liveCitations,
        linkItems: request.linkItems,
    }, { windowId: getWindowRuntime().id });
    return {
        ...result,
        runIds: source.provenance.runIds,
        ...(request.includeSource ? { source } : {}),
    };
}
