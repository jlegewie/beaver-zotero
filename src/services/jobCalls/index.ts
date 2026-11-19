/**
 * `addon.jobCalls` wired to Zotero: the plugin database, the parked-call
 * result endpoint, the fill service, and the instance runtime that tells
 * windows a result was stored. Plugin realm only.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    JOB_CALL_STORED_EVENT,
    isJobKind,
    type JobDevice,
    type JobResult,
    type StoredJobCall,
} from '@beaver/agent-core/protocol/jobCallProtocol';
import { getZoteroUserIdentifier } from '../../utils/zoteroInstanceIdentity';
import { readTable } from '../artifacts/tableItemIdentity';
import type { TableFillJobCalls, TableFillJobCoverage } from '../tableFills/service';
import { interruptedFillResult } from './interruptedFill';
import { jobCallApiClient } from './jobCallApi';
import { InstanceJobCalls, type JobCallEntry, type JobCallStorage } from './service';

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
    const coverage = entry.coverage as unknown as TableFillJobCoverage;
    if (!coverage?.target || !Array.isArray(coverage.rows)) return null;
    const fills = Zotero.Beaver.tableFills;
    // A table Beaver may no longer send reports nothing of itself.
    if (fills?.tableRefusal(coverage.target)) return null;
    const { spec } = await readTable(coverage.target);
    return interruptedFillResult(entry.jobId, coverage, spec, (value) => fills?.sendable(value) ?? false);
}

function sendable(entry: JobCallEntry, result: JobResult): JobResult | null {
    const target = (entry.coverage as unknown as Partial<TableFillJobCoverage>).target;
    const fills = Zotero.Beaver.tableFills;
    if (!target || !fills) return null;
    return fills.agent.sendableJobResult(result, target);
}

function isLive(_kind: JobCallEntry['kind'], jobId: string): boolean {
    const job = Zotero.Beaver.tableFills?.getJob(jobId);
    return !!job && job.state !== 'done';
}

/**
 * Tell windows a result was stored: windows showing the thread put it on the
 * call, and the window that has been waiting on the job resumes the run.
 */
function announceStored(stored: StoredJobCall): void {
    markStored(stored);
    Zotero.Beaver.runtime.publish(JOB_CALL_STORED_EVENT, stored);
}

/**
 * The thread lists' copy of the thread: its job call no longer counts as
 * running. The backend's own `awaiting_input` says the same; this device has
 * no realtime feed of it.
 */
function markStored(stored: StoredJobCall): void {
    try {
        const thread = Zotero.Beaver.threads.getSnapshot().entities.get(stored.threadId);
        if (!thread?.awaitingInput?.[stored.kind]) return;
        const awaiting: Record<string, number> = { ...thread.awaitingInput };
        const left = awaiting[stored.kind] - 1;
        if (left > 0) awaiting[stored.kind] = left;
        else delete awaiting[stored.kind];
        Zotero.Beaver.threads.patchThread(stored.threadId, {
            awaitingInput: Object.keys(awaiting).length ? awaiting : null,
        });
    } catch (error) {
        logger(`jobCalls: could not update ${stored.threadId} in the thread lists: ${String(error)}`, 1);
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
export type { JobCallEntry } from './service';
