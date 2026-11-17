/**
 * The provider operations a chat run's `fill_table` sends: `fill_plan` builds
 * a plan with the fill service, `fill` starts it as a job.
 *
 * One tool call is one job: the first `fill` of a tool call starts its plan,
 * and any later `fill` of the same tool call and plan (re-sent after a
 * reattach without the run's reply memory) answers from that job. Calls are
 * told apart by plan as well as by tool call id, since some models reuse tool
 * call ids across responses; a plan is unique and runs once. With `wait` the handler
 * answers `done` when the job ends, or `running` at the safety deadline, which
 * runs from the first arrival of the tool call's request on this clock; the
 * job goes on either way. Without `wait` it answers `running` once the job
 * has started. A user stopping the run that waits stops the job; rows in
 * flight finish.
 *
 * Job calls: a `fill` with `job_call` starts the job without waiting and
 * keeps its tool call in the job-call list, which stores the result on the
 * parked call if the run does not wait for it to the end. The run waits, if at
 * all, through `job_wait_request` ({@link AgentTableFills.waitJob}), which the
 * backend can release by parking the call.
 */

import type { AgentDataRequestContext } from '@beaver/agent-core/transport/agentDataDispatch';
import type { ArtifactRequest, ArtifactResponse } from '@beaver/agent-core/protocol/artifactProtocol';
import {
    fillProgress,
    type TableFillJobSnapshot,
    type TableFillOrigin,
    type TableFillResult,
    type TableFillScope,
    type TableFillTarget,
    type TableFillWirePlan,
} from '@beaver/agent-core/protocol/tableFillProtocol';
import type { TableFillJobResult, WSJobWaitRequest, WSJobWaitResponse } from '@beaver/agent-core/protocol/jobCallProtocol';
import type { InstanceTableFills } from './service';

/** The default safety deadline on a waiting `fill`, in ms. */
export const DEFAULT_FILL_WAIT_MS = 8 * 60_000;

interface ToolCallJob {
    jobId: string;
    /** When the tool call's first `fill` arrived. */
    firstArrival: number;
    /**
     * The job's last snapshot once it ended, kept after the service lets the
     * job go (its result dismissed in the tab, a later fill of the table,
     * retention), so a replay of the tool call still answers with it.
     */
    ended?: TableFillJobSnapshot;
}

/**
 * The message of a refusal as it leaves the device: fixed per code, never the
 * service's own text, which can quote a stored table.
 */
const REFUSALS: Record<string, string> = {
    unknown_row: 'A row of the fill is not in the table.',
    unknown_column: 'A column of the fill is not in the table.',
    invalid_column: 'Only question columns are filled.',
    table_unavailable: 'The table is not available for filling.',
    library_excluded: 'This table is in a library Beaver cannot access.',
    read_only: 'This library is read-only.',
    pricing_unavailable: 'Could not get the price of a fill.',
    signed_out: 'Beaver is not signed in, or the account changed.',
    plan_not_found: 'This fill plan is no longer available.',
    plan_expired: 'This fill plan has expired.',
    fill_in_progress: 'This table is already being filled.',
    nothing_to_fill: 'Nothing in this plan is left to fill.',
    stopped: 'The run was stopped before the fill started.',
};

type Started =
    | { ok: true; entry: ToolCallJob }
    | { ok: false; code: string; job_id?: string };

function failure(request: ArtifactRequest, code: string, extra: Partial<ArtifactResponse> = {}): ArtifactResponse {
    return {
        type: 'artifact_response',
        request_id: request.request_id,
        op: request.op,
        ok: false,
        conflict: false,
        error_code: code,
        error: REFUSALS[code] ?? 'The fill was refused.',
        ...extra,
    };
}

export class AgentTableFills {
    /** Tool call and plan → its job, once started. */
    private jobs = new Map<string, ToolCallJob>();
    /** Tool call and plan → its start in progress, so two arrivals start one job. */
    private starting = new Map<string, Promise<Started>>();

    constructor(
        private readonly fills: InstanceTableFills,
        private readonly waitMs: () => number = () => DEFAULT_FILL_WAIT_MS,
        private readonly now: () => number = () => Date.now(),
    ) {}

    /** `fill_plan`: a plan for the table, kept by the service under its id. */
    async plan(request: ArtifactRequest, target: TableFillTarget): Promise<ArtifactResponse> {
        const scope: TableFillScope =
            request.rows || request.columns
                ? { kind: 'cells', ...(request.rows ? { rows: request.rows } : {}), ...(request.columns ? { columns: request.columns as string[] } : {}) }
                : { kind: 'pending' };
        const result = await this.fills.plan(target, scope);
        if (!result.ok) return failure(request, result.code);
        // The library may have been excluded while the plan was built.
        const gone = this.fills.tableRefusal(target);
        if (gone) return failure(request, gone);
        const summary = result.plan;
        // The pending work names every pending column, not only the planned
        // ones the plan's own check covered.
        if (!this.fills.sendable(summary.pending))
            return failure(request, 'table_unavailable');
        const plan: TableFillWirePlan = {
            plan_id: summary.plan_id,
            rows: summary.rows,
            cells: summary.cells,
            documents: summary.documents,
            document_kinds: summary.document_kinds,
            title_abstract: summary.title_abstract,
            no_input: summary.no_input,
            unavailable: summary.unavailable,
            columns: this.fills.plannedColumns(summary.plan_id),
            credits: summary.credits,
            prices: summary.prices,
            pending: summary.pending,
            balance: summary.balance,
            expires_at: summary.expires_at,
        };
        return { type: 'artifact_response', request_id: request.request_id, op: request.op, ok: true, plan };
    }

    /** `fill`: start the plan as the tool call's job, and answer `done` or `running`. */
    async fill(request: ArtifactRequest, context?: AgentDataRequestContext): Promise<ArtifactResponse> {
        const started = await this.start(request, context);
        // A start shared by two arrivals of the tool call answers each with its own request.
        if (!started.ok) return failure(request, started.code, started.job_id ? { job_id: started.job_id } : {});
        const { jobId } = started.entry;
        let snapshot = this.fills.getJob(jobId) ?? started.entry.ended ?? null;
        if (!snapshot) return failure(request, 'plan_not_found');
        if (request.wait && snapshot.state !== 'done') {
            snapshot = await this.waitUntil(snapshot, started.entry.firstArrival + this.waitMs(), context);
        }
        if (request.job_call) this.registerJobCall(request, snapshot, context);
        const device = request.job_call ? this.fills.jobCalls?.device() : undefined;
        if (snapshot.state === 'done' && snapshot.result) {
            started.entry.ended = snapshot;
            return { ...this.answer(request, snapshot, 'done'), ...device };
        }
        return { ...this.answer(request, snapshot, 'running'), ...device };
    }

    /** Keep a job call's tool call, so its result can be stored once the job ends. */
    private registerJobCall(request: ArtifactRequest, snapshot: TableFillJobSnapshot, context?: AgentDataRequestContext): void {
        const jobCalls = this.fills.jobCalls;
        const threadId = context?.run?.threadId ?? snapshot.origin.run?.thread_id;
        const toolCallId = request.tool_call_id;
        if (!jobCalls || !threadId || !toolCallId) return;
        const coverage = this.fills.jobCoverage(snapshot.job_id);
        if (!coverage) return;
        jobCalls.register({ threadId, toolCallId, jobId: snapshot.job_id, coverage });
        // A job that ended before it was registered reports its end now.
        if (snapshot.state === 'done' && snapshot.result) jobCalls.jobEnded(snapshot, this.jobResult(snapshot));
    }

    /**
     * `job_wait_request`: wait for a job call's job, as part of the run. Answers
     * `done` with the job's result once it ends, `running` at the request's
     * deadline, `not_found` for a job this device does not know. A user
     * stopping the run that waits stops the job; the answer then comes once it
     * has ended as stopped.
     */
    async waitJob(request: WSJobWaitRequest, context?: AgentDataRequestContext): Promise<WSJobWaitResponse> {
        const reply = (status: WSJobWaitResponse['status'], snapshot?: TableFillJobSnapshot): WSJobWaitResponse => ({
            type: 'job_wait_response',
            request_id: request.request_id,
            job_id: request.job_id,
            status,
            ...(status === 'done' && snapshot ? { result: this.jobResult(snapshot) } : {}),
        });
        const endedSnapshot = (): TableFillJobSnapshot | null => {
            for (const entry of this.jobs.values()) if (entry.jobId === request.job_id && entry.ended) return entry.ended;
            return null;
        };
        let snapshot = this.fills.getJob(request.job_id) ?? endedSnapshot();
        if (!snapshot) return reply('not_found');
        if (snapshot.state !== 'done') {
            const timeoutMs = Math.max(0, (Number(request.timeout_seconds) || 0) * 1000);
            snapshot = await this.waitUntil(snapshot, (context?.receivedAt ?? this.now()) + timeoutMs, context, {
                untilStopped: true,
            });
        }
        return snapshot.state === 'done' && snapshot.result ? reply('done', snapshot) : reply('running');
    }

    /**
     * Wait for a job to end, until `deadline` on this clock. The user stopping
     * the run that waits stops the job; with `untilStopped` the wait then goes
     * on until the stopped job has ended (rows in flight finish), so the
     * answer reports them.
     */
    private async waitUntil(
        snapshot: TableFillJobSnapshot,
        deadline: number,
        context?: AgentDataRequestContext,
        options: { untilStopped?: boolean } = {},
    ): Promise<TableFillJobSnapshot> {
        const jobId = snapshot.job_id;
        context?.reportPhase('filling');
        const stop = () => this.fills.stop(jobId);
        const signal = context?.runStopped;
        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', stop, { once: true });
        try {
            snapshot = (await this.fills.wait(jobId, Math.max(0, deadline - this.now()))) ?? snapshot;
            while (options.untilStopped && snapshot.state !== 'done' && signal?.aborted) {
                snapshot = (await this.fills.wait(jobId, 60_000)) ?? snapshot;
            }
        } finally {
            signal?.removeEventListener('abort', stop);
        }
        return snapshot;
    }

    /**
     * A finished job's result as a job call carries it, filtered like the
     * live `done` answer: nothing naming an excluded library's item leaves the
     * device.
     */
    jobResult(snapshot: TableFillJobSnapshot): TableFillJobResult {
        return {
            kind: 'table_fill',
            job_id: snapshot.job_id,
            status: 'done',
            progress: fillProgress(snapshot),
            // A table whose library was excluded since the fill started sends only its counts.
            result: this.outbound(snapshot.result!, !!this.fills.tableRefusal(snapshot.table)),
        };
    }

    /**
     * A job-call result kept since its job ended, as it may leave the device
     * now: a library excluded meanwhile sends nothing of its items.
     */
    sendableJobResult(job: TableFillJobResult, target: TableFillTarget): TableFillJobResult {
        const result = this.outbound(job.result, !!this.fills.tableRefusal(target));
        return result === job.result ? job : { ...job, result };
    }

    /**
     * A result as it may leave the device: nothing naming an excluded
     * library's item, a pending column's header or a row id. `refused` drops
     * both outright.
     */
    private outbound(result: TableFillResult, refused = false): TableFillResult {
        if (!refused && this.fills.sendable(result)) return result;
        return {
            ...result,
            pending: !refused && result.pending && this.fills.sendable(result.pending) ? result.pending : null,
            failed_row_ids: refused ? [] : result.failed_row_ids.filter((id) => this.fills.sendable(id)),
        };
    }

    /** The tool call's job: the one it already started, or a new one from the plan. */
    private start(request: ArtifactRequest, context?: AgentDataRequestContext): Promise<Started> {
        const toolCall = request.tool_call_id!;
        const key = `${request.plan_id}\u0000${toolCall}`;
        const known = this.jobs.get(key);
        if (known && (known.ended || this.fills.getJob(known.jobId))) return Promise.resolve({ ok: true, entry: known });
        const pending = this.starting.get(key);
        if (pending) return pending;
        const firstArrival = context?.receivedAt ?? this.now();
        const run = context?.run;
        const origin: TableFillOrigin = {
            kind: 'agent',
            ...(run?.threadId
                ? { run: { run_id: run.runId, thread_id: run.threadId, tool_call_id: toolCall } }
                : {}),
        };
        // Stop response before the job exists: it never starts.
        const mayStart = () => !context?.runStopped?.aborted;
        const promise = this.fills.start(request.plan_id!, origin, mayStart).then((result): Started => {
            if (!result.ok) return { ok: false, code: result.code, ...(result.job_id ? { job_id: result.job_id } : {}) };
            const entry = { jobId: result.job.job_id, firstArrival };
            this.jobs.set(key, entry);
            return { ok: true, entry };
        });
        this.starting.set(key, promise);
        void promise.finally(() => this.starting.delete(key)).catch(() => {});
        return promise;
    }

    private answer(
        request: ArtifactRequest,
        snapshot: TableFillJobSnapshot,
        status: 'done' | 'running',
    ): ArtifactResponse {
        // A table whose library was excluded since the fill started sends nothing of itself.
        const gone = this.fills.tableRefusal(snapshot.table);
        if (gone) return failure(request, gone);
        const result = snapshot.result;
        return {
            type: 'artifact_response',
            request_id: request.request_id,
            op: request.op,
            ok: true,
            status,
            job_id: snapshot.job_id,
            progress: fillProgress(snapshot),
            ...(status === 'done' && result ? { result: this.outbound(result) } : {}),
        };
    }

    /** A job ended: its tool call's entry keeps the final snapshot. */
    noteEnded(snapshot: TableFillJobSnapshot): void {
        if (snapshot.state !== 'done' || !snapshot.result) return;
        for (const entry of this.jobs.values()) if (entry.jobId === snapshot.job_id) entry.ended = snapshot;
        // The job-call list stores the result if a parked call is waiting for it.
        if (snapshot.origin.kind === 'agent') this.fills.jobCalls?.jobEnded(snapshot, this.jobResult(snapshot));
    }

    dispose(): void {
        this.jobs.clear();
        this.starting.clear();
    }
}
