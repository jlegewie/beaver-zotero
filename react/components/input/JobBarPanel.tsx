import React, { useEffect, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import JobBarStack from '@beaver/agent-ui/chat/JobBarStack';
import type { JobView } from '@beaver/agent-ui/chat/JobBar';
import { getHost } from '@beaver/agent-ui/host';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { activeRunIdAtom, chatFillsAtom, panelFill, type ChatFill } from '@beaver/agent-core/run-state/tableChatFills';
import { failedRowsLink, progressLine } from '@beaver/agent-core/run-state/tableFillCopy';
import {
    fillLabel,
    fillResultLine,
    fillTone,
    isStoppedJobResult,
    openJobCallsAtom,
    pdfLabel,
    pdfMissingText,
    pdfProgressLine,
    pdfResultSummary,
    pdfResultTone,
} from '@beaver/agent-core/run-state/jobCalls';
import {
    jobIdOf,
    type JobDeferral,
    type JobResult,
    type PdfRetrievalJobResult,
    type PdfJobSnapshot,
    type PdfRetrievalJobState,
    type TableFillJobState,
} from '@beaver/agent-core/protocol/jobCallProtocol';
import type { TableFillJobSnapshot, TableFillResult, TableFillViewRequest } from '@beaver/agent-core/protocol/tableFillProtocol';
import { getZoteroUserIdentifier } from '../../../src/utils/zoteroInstanceIdentity';
import { libraryRefForLibraryID } from '../../../src/utils/libraryIdentity';
import { watchChatFills } from '../../atoms/tableChatFills';
import { chatPdfJobsAtom, watchJobCalls } from '../../atoms/jobCalls';
import { continueParkedJobsAtom } from '../../atoms/agentRunAtoms';
import { openPreferencesWindow } from '../../ui/openPreferencesWindow';

/**
 * This device's local user key, to tell a job running here from one
 * elsewhere. Read once: the lookup also resolves the host name.
 */
let deviceKey: string | null | undefined;
function localDeviceKey(): string | null {
    if (deviceKey !== undefined) return deviceKey;
    try {
        deviceKey = getZoteroUserIdentifier().localUserKey;
    } catch {
        deviceKey = null;
    }
    return deviceKey;
}

function openTable(tableKey: string | null | undefined, request?: TableFillViewRequest): void {
    if (!tableKey) return;
    const open = getHost().navigation?.openTable;
    // The host reports a table that cannot be opened.
    void open?.(tableKey, null, request ? { request } : undefined)?.catch?.(() => undefined);
}

function tableKeyOf(snapshot: TableFillJobSnapshot): string | null {
    const ref = libraryRefForLibraryID(snapshot.table.libraryID);
    return ref ? `${ref}-${snapshot.table.key}` : null;
}

/** The result links of a finished fill: credits when it ran out, then its failed rows. */
function fillLinks(result: TableFillResult, jobId: string, tableKey: string | null | undefined): JobView['links'] {
    const links: JobView['links'] = [];
    if (result.stopped_by === 'insufficient_credits')
        links.push({ label: 'Add credits', onClick: () => openPreferencesWindow('billing') });
    const failed = result.failed_row_ids.length;
    if (failed > 0 && tableKey)
        links.push({
            label: failedRowsLink(failed),
            onClick: () => openTable(tableKey, { kind: 'show_failed', job_id: jobId, row_ids: result.failed_row_ids }),
        });
    return links;
}

/** A finished fill: how it ended, its follow-ups, and the actions given. */
function readyFillView(
    id: string,
    jobId: string,
    result: TableFillResult,
    total: number,
    subject: string | undefined,
    tableKey: string | null | undefined,
    actions: JobView['actions'],
): JobView {
    return {
        id,
        kind: 'table_fill',
        verb: fillLabel(result),
        subject,
        state: 'ready',
        tone: fillTone(result),
        status: fillResultLine(result, total),
        open: tableKey ? () => openTable(tableKey) : undefined,
        links: fillLinks(result, jobId, tableKey),
        actions,
    };
}

/** A fill this device runs or ran, from its live snapshot. */
function liveFillView(fill: ChatFill): JobView {
    const snapshot = fill.snapshot;
    const tableKey = tableKeyOf(snapshot);
    const subject = snapshot.table.title || undefined;
    if (snapshot.state === 'done' && snapshot.result)
        return readyFillView(snapshot.job_id, snapshot.job_id, snapshot.result, snapshot.rows_total, subject, tableKey, []);
    const stopping = snapshot.state === 'stopping';
    // Items read so far, failures apart ("Reading 6 of 12 items · 1 failed").
    const done = Math.max(0, snapshot.rows_done - snapshot.rows_failed);
    const line = progressLine({ ...snapshot, rows_done: done });
    // Items have finished, though none read yet (they failed): the job has started.
    if (done === 0 && snapshot.rows_done > 0) line.status = `Reading 0 of ${snapshot.rows_total} ${snapshot.rows_total === 1 ? 'item' : 'items'}`;
    return {
        id: snapshot.job_id,
        kind: 'table_fill',
        verb: fillLabel(),
        subject,
        state: stopping ? 'stopping' : 'running',
        progress: snapshot.rows_done === 0
            ? 'indeterminate'
            : { done, failed: Math.min(snapshot.rows_failed, snapshot.rows_done), total: snapshot.rows_total },
        status: stopping
            ? snapshot.in_flight > 0
                ? `Finishing ${snapshot.in_flight} ${snapshot.in_flight === 1 ? 'item' : 'items'} already started`
                : 'Wrapping up'
            : line.status,
        ...(!stopping && line.failed ? { statusWarning: line.failed } : {}),
        open: tableKey ? () => openTable(tableKey) : undefined,
        links: [],
        // Stopped from the composer, as any work of the chat is.
        actions: [],
    };
}

/** A finished job's actions: Continue, unless the user stopped it (their next message moves on). */
function continueActions(result: JobResult, continueAction: JobView['actions'][number]): JobView['actions'] {
    return isStoppedJobResult(result) ? [] : [continueAction];
}

/** A parked fill job call. */
function parkedFillView(
    call: JobDeferral,
    live: ChatFill | null,
    device: string | null,
    continueAction: JobView['actions'][number],
): JobView {
    const state = (call.state ?? {}) as TableFillJobState;
    const subject = state.title || undefined;
    const tableKey = state.table;
    const open = tableKey ? () => openTable(tableKey) : undefined;
    if (call.result?.kind === 'table_fill') {
        const total = call.result.progress.rows_total || state.rows || 0;
        return readyFillView(call.tool_call_id, call.result.job_id, call.result.result, total, subject, tableKey, continueActions(call.result, continueAction));
    }
    if (live) return { ...liveFillView(live), id: call.tool_call_id };
    const elsewhere = !!state.device_key && !!device && state.device_key !== device;
    const name = state.device_name || 'another device';
    return {
        id: call.tool_call_id,
        kind: 'table_fill',
        verb: fillLabel(),
        subject,
        // Started here, but this renderer does not follow it (Zotero restarted
        // since): its result is being worked out and stored.
        state: elsewhere ? 'elsewhere' : 'running',
        progress: 'indeterminate',
        status: elsewhere ? `Running on ${name}` : 'Waiting for Zotero to report the fill',
        ...(elsewhere ? { device: name } : {}),
        open,
        links: [],
        actions: [],
    };
}

/** PDFs that were looked for and not found (a stopped fetch is not "not found"). */
function pdfsNotFound(result: PdfRetrievalJobResult): number {
    return result.items.filter((item) => item.attachment_status === 'failed' && item.failure_reason !== 'cancelled').length;
}

/** A finished PDF retrieval, from its stored result. */
function readyPdfView(id: string, result: PdfRetrievalJobResult, actions: JobView['actions']): JobView {
    const missing = pdfMissingText(pdfsNotFound(result));
    return {
        id,
        kind: 'pdf_retrieval',
        verb: pdfLabel(result),
        state: 'ready',
        tone: pdfResultTone(result),
        status: pdfResultSummary(result),
        ...(missing ? { statusWarning: missing } : {}),
        links: [],
        actions,
    };
}

/** A PDF retrieval this device runs, from its live snapshot: progress and Stop, or how it ended. */
function livePdfView(id: string, job: PdfJobSnapshot): JobView {
    const missing = pdfMissingText(job.failed);
    const pdfs = (n: number) => `${n} of ${job.total} ${job.total === 1 ? 'PDF' : 'PDFs'}`;
    if (job.ended) {
        const stopped = (job.cancelled ?? 0) > 0;
        return {
            id,
            kind: 'pdf_retrieval',
            verb: stopped ? 'PDF fetch stopped' : 'PDFs fetched',
            state: 'ready',
            tone: !stopped && job.total > 0 && job.found === 0 ? 'error' : job.found === job.total ? 'clean' : 'warning',
            status: stopped
                ? `Stopped after ${pdfs(job.found)}`
                : job.found === job.total ? `Found ${job.total} ${job.total === 1 ? 'PDF' : 'PDFs'}` : `Found ${pdfs(job.found)}`,
            ...(missing ? { statusWarning: missing } : {}),
            links: [],
            actions: [],
        };
    }
    return {
        id,
        kind: 'pdf_retrieval',
        verb: pdfLabel(),
        state: 'running',
        progress: job.found + job.failed === 0 ? 'indeterminate' : { done: job.found, failed: job.failed, total: job.total },
        status: pdfProgressLine(job.found, job.total),
        ...(missing ? { statusWarning: missing } : {}),
        links: [],
        // Stopped from the composer, as any work of the chat is.
        actions: [],
    };
}

/** A parked PDF retrieval job call. */
function parkedPdfView(
    call: JobDeferral,
    live: PdfJobSnapshot | null,
    device: string | null,
    continueAction: JobView['actions'][number],
): JobView {
    const state = (call.state ?? {}) as PdfRetrievalJobState;
    if (call.result?.kind === 'pdf_retrieval') return readyPdfView(call.tool_call_id, call.result, continueActions(call.result, continueAction));
    if (live) return livePdfView(call.tool_call_id, live);
    const elsewhere = !!state.device_key && !!device && state.device_key !== device;
    const name = state.device_name || 'another device';
    return {
        id: call.tool_call_id,
        kind: 'pdf_retrieval',
        verb: pdfLabel(),
        state: elsewhere ? 'elsewhere' : 'running',
        progress: 'indeterminate',
        status: elsewhere ? `Running on ${name}` : 'Waiting for Zotero to report the PDFs',
        ...(elsewhere ? { device: name } : {}),
        links: [],
        actions: [],
    };
}

/** A stored job result as the bar reads it, without actions: for surfaces that add their own. */
export function storedResultView(id: string, result: JobResult, subject?: string): JobView {
    if (result.kind === 'pdf_retrieval') return readyPdfView(id, result, []);
    return readyFillView(id, result.job_id, result.result, result.progress.rows_total, subject, null, []);
}

/**
 * The jobs the open chat waits on, docked to the composer: the fill the run
 * going now waits for, and every job call of the parked run (running here,
 * running on another device, or finished and ready to continue with).
 */
export function useJobViews(): JobView[] {
    const fills = useAtomValue(chatFillsAtom);
    const threadId = useAtomValue(currentThreadIdAtom);
    const activeRunId = useAtomValue(activeRunIdAtom);
    const calls = useAtomValue(openJobCallsAtom);
    const pdfJobs = useAtomValue(chatPdfJobsAtom);
    const continueJobs = useSetAtom(continueParkedJobsAtom);
    return useMemo(() => {
        const views: JobView[] = [];
        const shownJobs = new Set<string>();
        const live = panelFill(fills, threadId, activeRunId);
        if (live) {
            views.push(liveFillView(live));
            shownJobs.add(live.snapshot.job_id);
        }
        // PDFs the run going now waits for (or that ended during its wait).
        for (const job of pdfJobs.values()) {
            if (!activeRunId || job.run_id !== activeRunId || job.thread_id !== threadId) continue;
            views.push(livePdfView(job.job_id, job));
            shownJobs.add(job.job_id);
        }
        if (!calls.length) return views;
        const device = localDeviceKey();
        const continueAction: JobView['actions'][number] = {
            id: 'continue',
            label: 'Continue',
            primary: true,
            disabled: !!activeRunId,
            onClick: () => void continueJobs(),
        };
        for (const call of calls) {
            const jobId = jobIdOf(call);
            if (shownJobs.has(jobId)) continue;
            if (call.kind === 'table_fill') {
                const fill = fills.get(jobId) ?? null;
                views.push(parkedFillView(call, fill, device, continueAction));
            } else {
                views.push(parkedPdfView(call, pdfJobs.get(jobId) ?? null, device, continueAction));
            }
        }
        return views;
    }, [fills, pdfJobs, threadId, activeRunId, calls, continueJobs]);
}

/**
 * The job bar above the composer: one bar per job the chat waits on. A
 * running job shows its progress (the composer's Stop stops it); a finished
 * one its result and Continue. Replaces the chat fill's progress panel.
 */
const JobBarPanel: React.FC = () => {
    useEffect(() => {
        watchChatFills();
        watchJobCalls();
    }, []);
    const jobs = useJobViews();
    if (!jobs.length) return null;
    return <JobBarStack jobs={jobs} />;
};

export default JobBarPanel;
