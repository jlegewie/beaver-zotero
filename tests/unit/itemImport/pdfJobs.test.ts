import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    InstancePdfJobs,
    PDF_JOB_RETENTION_MS,
    PENDING_ATTACHMENT_TTL_MS,
    type PdfJobsDeps,
} from '../../../src/services/itemImport/pdfJobs';
import type { JobCallEntry } from '../../../src/services/jobCalls/service';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

let ids = 0;
let seam: { register: ReturnType<typeof vi.fn>; jobEnded: ReturnType<typeof vi.fn> };
let deps: PdfJobsDeps & {
    cancelFetch: ReturnType<typeof vi.fn>;
    currentPdf: ReturnType<typeof vi.fn>;
    librarySendable: ReturnType<typeof vi.fn>;
};
let jobs: InstancePdfJobs;
let signedIn: boolean;
let hasSeam: boolean;

function makeJobs(settings?: ConstructorParameters<typeof InstancePdfJobs>[1]): InstancePdfJobs {
    return new InstancePdfJobs(deps, settings);
}

function started(actionId: string, zoteroKey: string, libraryId = 1, taskId?: string): void {
    jobs.fetchStarted({ actionId, threadId: 't1', libraryId, zoteroKey, taskId });
}

function settled(actionId: string, zoteroKey: string, status: 'available' | 'failed' = 'available', extra = {}): void {
    jobs.fetchSettled({
        actionId,
        libraryId: 1,
        zoteroKey,
        attachmentStatus: status,
        ...(status === 'available' ? { attachmentKey: `1-PDF${zoteroKey}`, accessMethod: 'doi' } : { failureReason: 'no_pdf_found' }),
        elapsedMs: 1200,
        ...extra,
    });
}

function startRequest(actionIds: string[], extra: Record<string, unknown> = {}): any {
    return {
        event: 'pdf_job_start_request',
        request_id: 'r1',
        thread_id: 'thread-1',
        tool_call_id: 'call-1',
        action_ids: actionIds,
        ...extra,
    };
}

function waitRequest(jobId: string, timeoutSeconds = 90): any {
    return { event: 'job_wait_request', request_id: 'w1', kind: 'pdf_retrieval', job_id: jobId, tool_call_id: 'call-1', timeout_seconds: timeoutSeconds };
}

function context(extra: Record<string, unknown> = {}): any {
    return { receivedAt: Date.now(), reportPhase: () => {}, ...extra };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    ids = 0;
    signedIn = true;
    hasSeam = true;
    seam = { register: vi.fn(), jobEnded: vi.fn() };
    deps = {
        jobCalls: () => (hasSeam ? seam : undefined),
        newId: () => `job-${++ids}`,
        device: () => ({ device_key: 'dev-key', device_name: 'Work-MacBook' }),
        signedIn: () => signedIn,
        librarySendable: vi.fn(() => true),
        libraryRef: (libraryId: number) => (libraryId === 1 ? 'u' : `g${libraryId}`),
        cancelFetch: vi.fn(),
        currentPdf: vi.fn(async () => null),
        setTimer: (callback, ms) => setTimeout(callback, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        now: () => Date.now(),
        log: vi.fn(),
    } as any;
    jobs = makeJobs();
});

afterEach(() => {
    jobs.dispose();
    vi.useRealTimers();
});

describe('InstancePdfJobs.start', () => {
    it('groups the fetches scheduled for the action ids into one job', async () => {
        started('a1', 'AAAA0001');
        started('a2', 'AAAA0002');
        started('a3', 'AAAA0003');
        settled('a1', 'AAAA0001');

        const response = await jobs.start(startRequest(['a1', 'a2']));

        expect(response).toMatchObject({
            type: 'pdf_job_start_response',
            request_id: 'r1',
            ok: true,
            job_id: 'job-1',
            device_key: 'dev-key',
            device_name: 'Work-MacBook',
            fetching: 1,
        });
        expect(response.items).toEqual([
            {
                action_id: 'a1',
                library_id: 1,
                zotero_key: 'AAAA0001',
                library_ref: 'u',
                attachment_status: 'available',
                attachment_key: '1-PDFAAAA0001',
                access_method: 'doi',
                elapsed_ms: 1200,
            },
            { action_id: 'a2', library_id: 1, zotero_key: 'AAAA0002', library_ref: 'u', attachment_status: 'pending' },
        ]);
        expect(jobs.isLive('job-1')).toBe(true);
    });

    it('ignores action ids no fetch was scheduled for', async () => {
        started('a1', 'AAAA0001');
        const response = await jobs.start(startRequest(['unknown', 'a1', 'a1']));
        expect(response.ok).toBe(true);
        expect(response.items?.map((item) => item.action_id)).toEqual(['a1']);
    });

    it('refuses a start whose action ids all have no fetch', async () => {
        const response = await jobs.start(startRequest(['unknown']));
        expect(response).toMatchObject({ ok: false, error_code: 'unknown_actions' });
        expect(seam.register).not.toHaveBeenCalled();
    });

    it('refuses a start while signed out', async () => {
        started('a1', 'AAAA0001');
        signedIn = false;
        const response = await jobs.start(startRequest(['a1']));
        expect(response).toMatchObject({ ok: false, error_code: 'signed_out' });
        expect(seam.register).not.toHaveBeenCalled();
    });

    it('registers the job call with the covered items when fetches are pending', async () => {
        started('a1', 'AAAA0001');
        started('a2', 'AAAA0002', 5);
        await jobs.start(startRequest(['a1', 'a2']));

        expect(seam.register).toHaveBeenCalledTimes(1);
        expect(seam.register).toHaveBeenCalledWith({
            threadId: 'thread-1',
            toolCallId: 'call-1',
            kind: 'pdf_retrieval',
            jobId: 'job-1',
            coverage: {
                items: [
                    { action_id: 'a1', library_id: 1, zotero_key: 'AAAA0001', library_ref: 'u' },
                    { action_id: 'a2', library_id: 5, zotero_key: 'AAAA0002', library_ref: 'g5' },
                ],
            },
        });
    });

    it('takes the thread id from the run context when the request has none', async () => {
        started('a1', 'AAAA0001');
        await jobs.start(startRequest(['a1'], { thread_id: undefined }), context({ run: { runId: 'run-1', threadId: 'ctx-thread' } }));
        expect(seam.register).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'ctx-thread' }));
    });

    it('does not register without a thread id or a job-call list', async () => {
        started('a1', 'AAAA0001');
        await jobs.start(startRequest(['a1'], { thread_id: null }));
        expect(seam.register).not.toHaveBeenCalled();

        hasSeam = false;
        started('a2', 'AAAA0002');
        const response = await jobs.start(startRequest(['a2']));
        expect(response.ok).toBe(true);
        expect(seam.register).not.toHaveBeenCalled();
    });

    it('has nothing to wait for when every fetch already settled', async () => {
        started('a1', 'AAAA0001');
        settled('a1', 'AAAA0001', 'failed');
        const response = await jobs.start(startRequest(['a1']));

        expect(response).toMatchObject({ ok: true, fetching: 0 });
        expect(response.items?.[0]).toMatchObject({ attachment_status: 'failed', failure_reason: 'no_pdf_found' });
        expect(seam.register).not.toHaveBeenCalled();
        expect(seam.jobEnded).not.toHaveBeenCalled();
        expect(jobs.isLive(response.job_id!)).toBe(false);
    });

    it('leaves items in libraries Beaver may not send out of the response', async () => {
        started('a1', 'AAAA0001', 1);
        started('a2', 'BBBB0002', 2);
        deps.librarySendable.mockImplementation((libraryId: number) => libraryId !== 2);

        const response = await jobs.start(startRequest(['a1', 'a2']));

        expect(response.items?.map((item) => item.zotero_key)).toEqual(['AAAA0001']);
        expect(response.fetching).toBe(1);
        expect(seam.register.mock.calls[0][0].coverage.items).toHaveLength(1);
    });
});

describe('job end', () => {
    it('ends when the last fetch settles and reports the result once', async () => {
        started('a1', 'AAAA0001');
        started('a2', 'AAAA0002');
        await jobs.start(startRequest(['a1', 'a2']));

        settled('a1', 'AAAA0001');
        expect(jobs.isLive('job-1')).toBe(true);
        expect(seam.jobEnded).not.toHaveBeenCalled();

        settled('a2', 'AAAA0002', 'failed');
        await vi.advanceTimersByTimeAsync(0);

        expect(jobs.isLive('job-1')).toBe(false);
        expect(seam.jobEnded).toHaveBeenCalledTimes(1);
        const [kind, jobId, result] = seam.jobEnded.mock.calls[0];
        expect(kind).toBe('pdf_retrieval');
        expect(jobId).toBe('job-1');
        expect(result).toMatchObject({ kind: 'pdf_retrieval', job_id: 'job-1', status: 'done' });
        expect(result.timed_out).toBeUndefined();
        expect(result.items.map((item: any) => item.attachment_status)).toEqual(['available', 'failed']);

        // Settling again changes nothing.
        settled('a2', 'AAAA0002', 'available');
        await vi.advanceTimersByTimeAsync(0);
        expect(seam.jobEnded).toHaveBeenCalledTimes(1);
    });

    it('matches a settled fetch by library and key when it carries no action id', async () => {
        started('a1', 'AAAA0001');
        await jobs.start(startRequest(['a1']));
        jobs.fetchSettled({ libraryId: 1, zoteroKey: 'AAAA0001', attachmentStatus: 'available', attachmentKey: '1-PDF' });
        await vi.advanceTimersByTimeAsync(0);
        expect(seam.jobEnded).toHaveBeenCalledTimes(1);
    });

    it('ends at the 5-minute cap with unfinished items still pending', async () => {
        started('a1', 'AAAA0001');
        started('a2', 'AAAA0002');
        await jobs.start(startRequest(['a1', 'a2']));
        settled('a1', 'AAAA0001');

        await vi.advanceTimersByTimeAsync(PENDING_ATTACHMENT_TTL_MS - 1);
        expect(seam.jobEnded).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(seam.jobEnded).toHaveBeenCalledTimes(1);
        const result = seam.jobEnded.mock.calls[0][2];
        expect(result.timed_out).toBe(true);
        expect(result.items.map((item: any) => item.attachment_status)).toEqual(['available', 'pending']);
        expect(jobs.isLive('job-1')).toBe(false);
    });

    it('takes the cap from its settings', async () => {
        jobs.dispose();
        jobs = makeJobs({ pendingTtlMs: 1000 });
        started('a1', 'AAAA0001');
        await jobs.start(startRequest(['a1']));
        await vi.advanceTimersByTimeAsync(1000);
        expect(seam.jobEnded.mock.calls[0][2].timed_out).toBe(true);
    });

    it('does not report the cap once the job ended', async () => {
        started('a1', 'AAAA0001');
        await jobs.start(startRequest(['a1']));
        settled('a1', 'AAAA0001');
        await vi.advanceTimersByTimeAsync(PENDING_ATTACHMENT_TTL_MS * 2);
        expect(seam.jobEnded).toHaveBeenCalledTimes(1);
    });

    it('leaves out items of a library that became unsendable before the end', async () => {
        started('a1', 'AAAA0001', 1);
        started('a2', 'BBBB0002', 2);
        await jobs.start(startRequest(['a1', 'a2']));
        deps.librarySendable.mockImplementation((libraryId: number) => libraryId !== 2);

        settled('a1', 'AAAA0001');
        jobs.fetchSettled({ actionId: 'a2', libraryId: 2, zoteroKey: 'BBBB0002', attachmentStatus: 'available', attachmentKey: '2-X' });
        await vi.advanceTimersByTimeAsync(0);

        expect(seam.jobEnded.mock.calls[0][2].items.map((item: any) => item.zotero_key)).toEqual(['AAAA0001']);
    });

    it('survives a job-call list that rejects', async () => {
        seam.jobEnded.mockRejectedValue(new Error('boom'));
        started('a1', 'AAAA0001');
        await jobs.start(startRequest(['a1']));
        settled('a1', 'AAAA0001');
        await vi.advanceTimersByTimeAsync(0);
        expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('could not report the end'));
    });

    it('forgets ended jobs and settled fetches after the retention', async () => {
        started('a1', 'AAAA0001');
        const { job_id } = await jobs.start(startRequest(['a1']));
        settled('a1', 'AAAA0001');
        expect((await jobs.waitJob(waitRequest(job_id!))).status).toBe('done');

        vi.setSystemTime(NOW + PDF_JOB_RETENTION_MS + 1);
        started('a2', 'AAAA0002');

        expect((await jobs.waitJob(waitRequest(job_id!))).status).toBe('not_found');
        expect(await jobs.start(startRequest(['a1']))).toMatchObject({ ok: false, error_code: 'unknown_actions' });
    });
});

describe('InstancePdfJobs.waitJob', () => {
    it('answers not_found for an unknown job', async () => {
        const response = await jobs.waitJob(waitRequest('nope'));
        expect(response).toEqual({ type: 'job_wait_response', request_id: 'w1', job_id: 'nope', status: 'not_found' });
    });

    it('answers done at once for a job that ended', async () => {
        started('a1', 'AAAA0001');
        const { job_id } = await jobs.start(startRequest(['a1']));
        settled('a1', 'AAAA0001');

        const response = await jobs.waitJob(waitRequest(job_id!));
        expect(response.status).toBe('done');
        expect(response.result).toMatchObject({ kind: 'pdf_retrieval', job_id });
    });

    it('answers done when the job ends during the wait', async () => {
        started('a1', 'AAAA0001');
        const { job_id } = await jobs.start(startRequest(['a1']));
        const pending = jobs.waitJob(waitRequest(job_id!), context());

        await vi.advanceTimersByTimeAsync(20_000);
        settled('a1', 'AAAA0001');

        const response = await pending;
        expect(response.status).toBe('done');
        expect((response.result as any).items[0].attachment_status).toBe('available');
    });

    it('answers running at the timeout measured from when the request arrived', async () => {
        started('a1', 'AAAA0001');
        const { job_id } = await jobs.start(startRequest(['a1']));
        // The request sat in a queue for 80 s of its 90 s.
        const pending = jobs.waitJob(waitRequest(job_id!, 90), context({ receivedAt: Date.now() - 80_000 }));

        let done = false;
        void pending.then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(9_999);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        const response = await pending;
        expect(response.status).toBe('running');
        expect(response.result).toBeUndefined();
        expect(jobs.isLive(job_id!)).toBe(true);
    });

    it('answers running when the request is withdrawn', async () => {
        started('a1', 'AAAA0001');
        const { job_id } = await jobs.start(startRequest(['a1']));
        const controller = new AbortController();
        const pending = jobs.waitJob(waitRequest(job_id!), context({ signal: controller.signal }));
        controller.abort();
        expect((await pending).status).toBe('running');
        expect(deps.cancelFetch).not.toHaveBeenCalled();
    });

    it('cancels the running fetches when the user stops the run', async () => {
        started('a1', 'AAAA0001', 1, 'task-1');
        started('a2', 'AAAA0002', 1, 'task-2');
        started('a3', 'AAAA0003', 1, 'task-3');
        const { job_id } = await jobs.start(startRequest(['a1', 'a2', 'a3']));
        settled('a1', 'AAAA0001');

        const stop = new AbortController();
        const pending = jobs.waitJob(waitRequest(job_id!), context({ runStopped: stop.signal }));
        stop.abort();

        const response = await pending;
        expect(response.status).toBe('done');
        expect(deps.cancelFetch).toHaveBeenCalledTimes(2);
        expect(deps.cancelFetch).toHaveBeenCalledWith(1, 'AAAA0002', 'task-2');
        expect(deps.cancelFetch).toHaveBeenCalledWith(1, 'AAAA0003', 'task-3');
        const items = (response.result as any).items;
        expect(items.map((item: any) => item.attachment_status)).toEqual(['available', 'failed', 'failed']);
        expect(items[1].failure_reason).toBe('cancelled');
        expect(items[0].failure_reason).toBeUndefined();
        expect((response.result as any).timed_out).toBeUndefined();
        // Stopping the run is the user's Stop: the result says so.
        expect((response.result as any).stopped).toBe(true);

        await vi.advanceTimersByTimeAsync(0);
        expect(seam.jobEnded).toHaveBeenCalledTimes(1);
        expect(jobs.isLive(job_id!)).toBe(false);
    });

    it('cancels at once when the run was already stopped', async () => {
        started('a1', 'AAAA0001', 1, 'task-1');
        const { job_id } = await jobs.start(startRequest(['a1']));
        const stop = new AbortController();
        stop.abort();

        const response = await jobs.waitJob(waitRequest(job_id!), context({ runStopped: stop.signal }));
        expect(response.status).toBe('done');
        expect(deps.cancelFetch).toHaveBeenCalledWith(1, 'AAAA0001', 'task-1');
    });

    it('ignores the cancelled fetch settling afterwards', async () => {
        started('a1', 'AAAA0001', 1, 'task-1');
        const { job_id } = await jobs.start(startRequest(['a1']));
        const stop = new AbortController();
        const pending = jobs.waitJob(waitRequest(job_id!), context({ runStopped: stop.signal }));
        stop.abort();
        await pending;

        settled('a1', 'AAAA0001', 'available');
        await vi.advanceTimersByTimeAsync(0);
        expect(seam.jobEnded).toHaveBeenCalledTimes(1);
        expect(seam.jobEnded.mock.calls[0][2].items[0].attachment_status).toBe('failed');
    });

    it('releases waiters on dispose', async () => {
        started('a1', 'AAAA0001');
        const { job_id } = await jobs.start(startRequest(['a1']));
        const pending = jobs.waitJob(waitRequest(job_id!), context());
        jobs.dispose();
        expect((await pending).status).toBe('running');
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('InstancePdfJobs.deriveInterrupted', () => {
    function entry(coverage: Record<string, unknown>): JobCallEntry {
        return {
            threadId: 't1',
            toolCallId: 'c1',
            userId: 'u1',
            kind: 'pdf_retrieval',
            jobId: 'job-9',
            coverage,
            result: null,
            createdAt: new Date(NOW).toISOString(),
        };
    }

    it('reports a present PDF as available and the rest as interrupted', async () => {
        deps.currentPdf.mockImplementation(async (_library: number, key: string) => (key === 'AAAA0001' ? 'PDFKEY01' : null));
        const result = await jobs.deriveInterrupted(
            entry({
                items: [
                    { action_id: 'a1', library_id: 1, zotero_key: 'AAAA0001', library_ref: 'u' },
                    { action_id: 'a2', library_id: 1, zotero_key: 'AAAA0002' },
                ],
            }),
        );

        expect(result).toEqual({
            kind: 'pdf_retrieval',
            job_id: 'job-9',
            status: 'done',
            interrupted: true,
            items: [
                { action_id: 'a1', library_id: 1, zotero_key: 'AAAA0001', library_ref: 'u', attachment_status: 'available', attachment_key: '1-PDFKEY01' },
                { action_id: 'a2', library_id: 1, zotero_key: 'AAAA0002', library_ref: 'u', attachment_status: 'failed', failure_reason: 'interrupted' },
            ],
        });
    });

    it('reports an item it cannot read as interrupted and leaves out unsendable libraries', async () => {
        deps.currentPdf.mockRejectedValue(new Error('item gone'));
        deps.librarySendable.mockImplementation((libraryId: number) => libraryId !== 2);
        const result = await jobs.deriveInterrupted(
            entry({
                items: [
                    { action_id: 'a1', library_id: 1, zotero_key: 'AAAA0001' },
                    { action_id: 'a2', library_id: 2, zotero_key: 'BBBB0002' },
                ],
            }),
        );
        expect(result?.items).toHaveLength(1);
        expect(result?.items[0]).toMatchObject({ attachment_status: 'failed', failure_reason: 'interrupted' });
    });

    it('returns null when the coverage cannot be read', async () => {
        expect(await jobs.deriveInterrupted(entry({}))).toBeNull();
        expect(await jobs.deriveInterrupted(entry({ items: 'x' }))).toBeNull();
        expect(await jobs.deriveInterrupted(entry({ items: [{ zotero_key: 'AAAA0001' }] }))).toBeNull();
    });
});

describe('following and stopping a job', () => {
    it('publishes the job as it starts, as fetches settle and when it ends', async () => {
        const publish = vi.fn();
        deps.publish = publish;
        jobs = makeJobs();
        started('a1', 'AAAA0001');
        started('a2', 'AAAA0002');
        await jobs.start(startRequest(['a1', 'a2'], { run_id: 'run-1' }));
        settled('a1', 'AAAA0001');
        settled('a2', 'AAAA0002', 'failed');
        expect(publish.mock.calls.map(([snapshot]) => [snapshot.found, snapshot.failed, snapshot.ended])).toEqual([
            [0, 0, false],
            [1, 0, false],
            [1, 1, true],
        ]);
        expect(publish.mock.calls[0][0]).toMatchObject({ job_id: 'job-1', thread_id: 'thread-1', tool_call_id: 'call-1', run_id: 'run-1', total: 2 });
        expect(jobs.listJobs()).toEqual([publish.mock.calls[2][0]]);
    });

    it('stops a running job: its fetches are cancelled and it ends now', async () => {
        started('a1', 'AAAA0001', 1, 'task-1');
        await jobs.start(startRequest(['a1']));
        expect(jobs.stop('job-1')).toBe(true);
        expect(deps.cancelFetch).toHaveBeenCalledWith(1, 'AAAA0001', 'task-1');
        expect(jobs.isLive('job-1')).toBe(false);
        expect(jobs.stop('job-1')).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(seam.jobEnded.mock.calls[0][2]).toMatchObject({ stopped: true });
    });

    it('marks a job that ends by itself as not stopped', async () => {
        started('a1', 'AAAA0001', 1, 'task-1');
        await jobs.start(startRequest(['a1']));
        settled('a1', 'AAAA0001', 'failed');
        await vi.advanceTimersByTimeAsync(0);
        expect(seam.jobEnded.mock.calls[0][2].stopped).toBeUndefined();
    });

    it('filters a kept result again for libraries excluded since', async () => {
        started('a1', 'AAAA0001', 1);
        started('a2', 'AAAA0002', 2);
        await jobs.start(startRequest(['a1', 'a2']));
        jobs.fetchSettled({ actionId: 'a1', libraryId: 1, zoteroKey: 'AAAA0001', attachmentStatus: 'available' });
        jobs.fetchSettled({ actionId: 'a2', libraryId: 2, zoteroKey: 'AAAA0002', attachmentStatus: 'available' });
        await vi.advanceTimersByTimeAsync(0);
        const [, , result] = seam.jobEnded.mock.calls[0];
        expect(result.items).toHaveLength(2);
        deps.librarySendable.mockImplementation((libraryId: number) => libraryId !== 2);
        expect(jobs.sendableResult(result).items.map((item: any) => item.library_id)).toEqual([1]);
        const answered = await jobs.waitJob(waitRequest('job-1'), context());
        expect(answered.result).toMatchObject({ items: [{ library_id: 1 }] });
    });
});
