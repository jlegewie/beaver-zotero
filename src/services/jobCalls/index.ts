/**
 * `addon.jobCalls` wired to Zotero: the plugin database, the parked-call
 * mailbox, the fill service and the PDF jobs, and the instance runtime that
 * tells windows a result was stored. Plugin realm only.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    JOB_CALL_STORED_EVENT,
    JOB_READY_KEY,
    isJobKind,
    type JobCallStoredNotification,
    type JobDevice,
    type JobResult,
} from '@beaver/agent-core/protocol/jobCallProtocol';
import { getZoteroUserIdentifier } from '../../utils/zoteroInstanceIdentity';
import { readTable } from '../artifacts/tableItemIdentity';
import type { TableFillJobCalls, TableFillJobCoverage } from '../tableFills/service';
import { interruptedFillResult } from './interruptedFill';
import { jobCallApiClient } from './jobCallApi';
import { InstanceJobCalls, type JobCallEntry, type JobCallStorage, type JobCallStored } from './service';

/** This device, as a job call names it. */
export function jobDevice(): JobDevice {
    try {
        const { localUserKey, deviceName } = getZoteroUserIdentifier();
        return { device_key: localUserKey, ...(deviceName ? { device_name: deviceName } : {}) };
    } catch {
        return {};
    }
}

const storage: JobCallStorage = {
    async upsert(entry) {
        await Zotero.Beaver.db?.upsertJobCall(toRecord(entry));
    },
    async setResult(entry, result) {
        await Zotero.Beaver.db?.setJobCallResult(entry.threadId, entry.toolCallId, entry.jobId, JSON.stringify(result));
    },
    async delete(entry) {
        await Zotero.Beaver.db?.deleteJobCall(entry.threadId, entry.toolCallId, entry.jobId);
    },
    async list() {
        const rows = (await Zotero.Beaver.db?.listJobCalls()) ?? [];
        const entries: JobCallEntry[] = [];
        for (const row of rows) {
            if (!isJobKind(row.kind)) continue;
            try {
                entries.push({
                    threadId: row.threadId,
                    toolCallId: row.toolCallId,
                    userId: row.userId,
                    kind: row.kind,
                    jobId: row.jobId,
                    coverage: JSON.parse(row.coverage),
                    result: row.result ? (JSON.parse(row.result) as JobResult) : null,
                    createdAt: row.createdAt,
                });
            } catch (error) {
                logger(`jobCalls: unreadable job call ${row.jobId}: ${String(error)}`, 1);
            }
        }
        return entries;
    },
};

function toRecord(entry: JobCallEntry) {
    return {
        threadId: entry.threadId,
        toolCallId: entry.toolCallId,
        userId: entry.userId,
        kind: entry.kind,
        jobId: entry.jobId,
        coverage: JSON.stringify(entry.coverage),
        result: entry.result ? JSON.stringify(entry.result) : null,
        createdAt: entry.createdAt,
    };
}

async function deriveInterrupted(entry: JobCallEntry): Promise<JobResult | null> {
    if (entry.kind === 'pdf_retrieval') return (await Zotero.Beaver.pdfJobs?.deriveInterrupted(entry)) ?? null;
    const coverage = entry.coverage as unknown as TableFillJobCoverage;
    if (!coverage?.target || !Array.isArray(coverage.rows)) return null;
    const fills = Zotero.Beaver.tableFills;
    // A table Beaver may no longer send reports nothing of itself.
    if (fills?.tableRefusal(coverage.target)) return null;
    const { spec } = await readTable(coverage.target);
    return interruptedFillResult(entry.jobId, coverage, spec, (value) => fills?.sendable(value) ?? false);
}

function sendable(entry: JobCallEntry, result: JobResult): JobResult | null {
    if (result.kind === 'pdf_retrieval') {
        const jobs = Zotero.Beaver.pdfJobs;
        return jobs ? jobs.sendableResult(result) : null;
    }
    const target = (entry.coverage as unknown as Partial<TableFillJobCoverage>).target;
    const fills = Zotero.Beaver.tableFills;
    if (!target || !fills) return null;
    return fills.agent.sendableJobResult(result, target);
}

function isLive(kind: JobCallEntry['kind'], jobId: string): boolean {
    if (kind === 'pdf_retrieval') return Zotero.Beaver.pdfJobs?.isLive(jobId) ?? false;
    const job = Zotero.Beaver.tableFills?.getJob(jobId);
    return !!job && job.state !== 'done';
}

function subjectOf(stored: JobCallStored): string | undefined {
    if (stored.result.kind === 'pdf_retrieval') {
        const n = stored.result.items.length;
        return `${n} ${n === 1 ? 'item' : 'items'}`;
    }
    const title = (stored.coverage as { title?: unknown }).title;
    return typeof title === 'string' && title ? title : undefined;
}

/** Tell windows a result was stored: the one showing the thread resumes the run. */
function announceStored(stored: JobCallStored): void {
    const subject = subjectOf(stored);
    const { coverage: _coverage, ...call } = stored;
    const runtime = Zotero.Beaver.runtime;
    const viewers = Zotero.Beaver.presence
        .getSnapshot()
        .viewers.filter((viewer) => viewer.threadId === stored.threadId)
        .map((viewer) => viewer.windowId);
    const notifyWindow = viewers.length === 0 ? runtime.resolveWindow() : undefined;
    const notification: JobCallStoredNotification = {
        ...call,
        viewerWindowIds: viewers,
        ...(notifyWindow ? { notifyWindowId: notifyWindow.id } : {}),
        ...(subject ? { subject } : {}),
    };
    markReady(stored);
    // No window ready to report it yet (Zotero is starting): the first
    // renderer that mounts reports it.
    if (!viewers.length && !notifyWindow) Zotero.Beaver.jobCalls?.hold(notification);
    else runtime.publish(JOB_CALL_STORED_EVENT, notification);
}

/**
 * The thread lists' copy of the thread: its job call now waits on the user
 * (`job_ready`), not on the job; a job the user stopped waits on nothing. The
 * backend's own `awaiting_input` says the same; this device has no realtime
 * feed of it.
 */
function markReady(stored: JobCallStored): void {
    try {
        const thread = Zotero.Beaver.threads.getSnapshot().entities.get(stored.threadId);
        if (!thread) return;
        const awaiting: Record<string, number> = { ...(thread.awaitingInput ?? {}) };
        const left = (awaiting[stored.kind] ?? 0) - 1;
        if (left > 0) awaiting[stored.kind] = left;
        else delete awaiting[stored.kind];
        if (!stored.result.stopped) awaiting[JOB_READY_KEY] = (awaiting[JOB_READY_KEY] ?? 0) + 1;
        Zotero.Beaver.threads.patchThread(stored.threadId, {
            awaitingInput: Object.keys(awaiting).length ? awaiting : null,
        });
    } catch (error) {
        logger(`jobCalls: could not mark ${stored.threadId} ready: ${String(error)}`, 1);
    }
}

export function createInstanceJobCalls(): InstanceJobCalls {
    return new InstanceJobCalls({
        storage,
        post: (entry, result) =>
            jobCallApiClient.storeResult(entry.threadId, entry.toolCallId, {
                kind: entry.kind,
                job_id: entry.jobId,
                result,
            }),
        userId: () => Zotero.Beaver.account?.getSnapshot().session?.user.id ?? null,
        subscribeAccount: (listener) => Zotero.Beaver.account?.subscribe(() => listener()) ?? (() => {}),
        ready: () => !!Zotero.Beaver.account?.getSnapshot().scopeReady && !!Zotero.Beaver.libraryScopeInitialized,
        isLive,
        deriveInterrupted,
        sendable,
        onStored: announceStored,
        shuttingDown: () => !!Zotero.__beaverShuttingDown,
        setTimer: (callback, ms) => setTimeout(callback, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        now: () => Date.now(),
        log: (message) => logger(message, 1),
    });
}

/** The fill service's job-call seam, backed by `addon.jobCalls`. */
export const tableFillJobCalls: TableFillJobCalls = {
    device: jobDevice,
    register: ({ threadId, toolCallId, jobId, coverage }) => {
        void Zotero.Beaver.jobCalls?.register({
            threadId,
            toolCallId,
            kind: 'table_fill',
            jobId,
            coverage: coverage as unknown as Record<string, unknown>,
        });
    },
    jobEnded: (snapshot, result) => {
        void Zotero.Beaver.jobCalls?.jobEnded('table_fill', snapshot.job_id, result);
    },
};

export { InstanceJobCalls } from './service';
export type { JobCallEntry, JobCallStored } from './service';
