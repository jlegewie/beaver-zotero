/**
 * Table fill jobs, owned by the plugin realm (`addon.tableFills`).
 *
 * A fill always runs an approved plan. {@link InstanceTableFills.plan} builds
 * one and keeps it under a `plan_id`: the exact cells to fill, each row's
 * documents, each column's revision and question hash, the prices it was
 * costed at and the counts and cost the Fill popover shows. A plan is
 * immutable and expires after an hour. {@link InstanceTableFills.start}
 * validates it against the table as it is now, dropping work that went away
 * and never adding any, and runs it as a job.
 *
 * A job belongs to the plugin, not to a window: closing a window or a tab
 * does not stop it. It takes the table's fill lease (one fill per table on
 * this device) and belongs to the account generation that started it. It
 * reads each row's document locally, posts the row to the backend's fill
 * endpoint, and commits the answers in batches through the instance mutation
 * queue and the store's session path, where cells whose column, question or
 * row documents changed meanwhile are skipped. Stop starts no new rows and
 * lets the rows in flight finish; nothing is aborted mid-request. Progress is
 * published through `addon.runtime`; nothing polls.
 *
 * Nothing needs resuming after a quit: pending work is derived from the
 * table, and the next fill picks up the rest.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { questionHash, type Cell, type TableSpec } from '@beaver/agent-core/layouts/table';
import { applyMutations, type CellWrite, type SkippedCell, type TableMutation } from '@beaver/agent-core/layouts/tableMutations';
import {
    cellsToFill,
    pendingWork,
    retryableFailedRows,
    rowFailure,
    selectedColumns,
    TableSelectionError,
    type FillSelection,
} from '@beaver/agent-core/layouts/tableFill';
import {
    TABLE_FILL_CHANGED_EVENT,
    type TableFillColumn,
    type TableFillJobSnapshot,
    type TableFillNotStartedReason,
    type TableFillOrigin,
    type TableFillPlanResult,
    type TableFillPlanSummary,
    type TableFillPricing,
    type TableFillResponse,
    type TableFillResult,
    type TableFillScope,
    type TableFillStartResult,
    type TableFillTarget,
} from '@beaver/agent-core/protocol/tableFillProtocol';
import type { Row } from '@beaver/agent-core/layouts/table';
import {
    buildPlan,
    readFailureCode,
    requestDocumentKind,
    rowsToLookUp,
    type DocumentUpdate,
    type PlannedColumn,
    type RowLookup,
    type RowPlan,
} from './planner';
import { classifyFillError, fillRequestBody, type SerializedFillDocument } from './tableFillApi';

/** A table as the store returns it. */
export interface TableFillTableRead {
    spec: TableSpec;
    version: number;
}

/** The result of one commit through the store's session path. */
export type TableFillCommitResult =
    | { ok: true; skipped: SkippedCell[] }
    | { ok: false; error: { code: string; message: string } };

/** A document read for the endpoint, or why it could not be read. */
export type TableFillDocumentRead =
    | { ok: true; json: string; contentKind: string }
    | { ok: false; code: string; contentKind?: string };

/** Everything the service needs from Zotero, the store, the account and the network. */
export interface TableFillDeps {
    readTable(target: TableFillTarget): Promise<TableFillTableRead>;
    /** Why the table cannot be written, or null. */
    writeRefusal(target: TableFillTarget): 'read_only' | 'table_unavailable' | null;
    lookupRows(rows: readonly Row[]): Promise<Map<string, RowLookup>>;
    /** Whether the row may be sent off the device (library exclusions). */
    rowSendable(row: Pick<Row, 'ref'>): boolean;
    /** Whether the document may be sent off the device (its library's exclusion). */
    documentSendable(documentId: string): boolean;
    /**
     * Whether text and fields bound for the backend reference no item of a
     * library Beaver may not read (item ids, citation tags, library refs).
     */
    contextSendable(value: unknown): boolean;
    readDocument(documentId: string): Promise<TableFillDocumentRead>;
    pricing(): Promise<TableFillPricing>;
    fill(body: string, assertDispatch: () => void): Promise<TableFillResponse>;
    commit(
        target: TableFillTarget,
        commit: { operation_id: string; seq: number; mutations: TableMutation[] },
        meta: { actor: 'agent'; collapse_key: string; change: string; run_id?: string; thread_id?: string },
        /** The job's commit check, run at queue admission and by the store just before the write. */
        mayCommit: () => void,
    ): Promise<TableFillCommitResult>;
    account: {
        generation(): number;
        signedIn(): boolean;
        /** Available credits from the account snapshot; null when unknown. */
        balance(): number | null;
        subscribe(listener: () => void): () => void;
        refreshProfile(): void;
    };
    publish(snapshot: TableFillJobSnapshot): void;
    newId(): string;
    now(): number;
}

export interface TableFillSettings {
    /** Rows in flight at once. */
    concurrency: number;
    /** Commit after this many answered rows wait. */
    commitRows: number;
    /** Or this long after the first one started waiting. */
    commitSeconds: number;
    /** How long a plan may wait before it starts. */
    planTtlMs: number;
    /** Retries of one row after a network error, a 429 or a 503. */
    maxRetries: number;
    /** Backoff before retry `n` (from 0), in ms, unless the server named one. */
    retryDelayMs(attempt: number): number;
    /** How long a finished job stays visible (the result banner). */
    finishedTtlMs: number;
    /** How long shutdown waits for a job's last commit. */
    shutdownFlushMs: number;
}

export const DEFAULT_TABLE_FILL_SETTINGS: TableFillSettings = {
    concurrency: 3,
    commitRows: 10,
    commitSeconds: 20,
    planTtlMs: 60 * 60_000,
    maxRetries: 5,
    retryDelayMs: (attempt) => Math.min(2_000 * 2 ** attempt, 30_000),
    finishedTtlMs: 60 * 60_000,
    shutdownFlushMs: 5_000,
};

/** How long a fetched price table is used before it is fetched again. */
const PRICING_TTL_MS = 60 * 60_000;

interface StoredPlan {
    summary: TableFillPlanSummary;
    generation: number;
    target: TableFillTarget;
    table: { title: string; description?: string };
    /** The table context every request of the plan carries: title, description, questions. */
    context: { table: { title: string; description?: string }; columns: TableFillColumn[] };
    /** The selection the plan was built from, re-run against the table at start. */
    selection: FillSelection;
    rows: RowPlan[];
    columns: Map<string, PlannedColumn>;
    documentUpdates: DocumentUpdate[];
}

function tableKey(target: TableFillTarget): string {
    return `${target.libraryID}/${target.key}`;
}

function sameDocuments(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
    const left = new Set(a ?? []);
    const right = new Set(b ?? []);
    return left.size === right.size && [...left].every((id) => right.has(id));
}

function round(credits: number): number {
    return Math.round(credits * 1e6) / 1e6;
}

function rowPrice(row: RowPlan, prices: TableFillPricing): number {
    if (row.mode === 'document') return prices.document;
    if (row.mode === 'metadata') return prices.title_abstract;
    return 0;
}

function documentKinds(rows: readonly RowPlan[]): TableFillPlanSummary['document_kinds'] {
    const kinds: TableFillPlanSummary['document_kinds'] = {};
    for (const row of rows) {
        if (row.mode !== 'document') continue;
        const kind = row.document?.kind ?? 'other';
        kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    return kinds;
}

/** A row's writes waiting for the next commit, and the answers they carry. */
interface PendingRow {
    row: string;
    mutations: TableMutation[];
    cells: { column: string; outcome: Cell['outcome']; fromTitleAbstract: boolean }[];
}

/**
 * Why a job may not send a row, or commit, now. `job` stops the whole job
 * (rows not started stay pending); `row` fails only the row it was asked
 * about, with that failure code.
 */
type Refusal =
    | { scope: 'job'; reason: TableFillNotStartedReason }
    | { scope: 'row'; code: string };

/** A refusal raised at a boundary that can only throw (a dispatch, the store's guard). */
class JobRefused extends Error {
    constructor(readonly refusal: Refusal) {
        super(refusal.scope === 'job' ? refusal.reason : refusal.code);
    }
}

/** One running fill. */
class FillJob {
    readonly id: string;
    readonly startedAt: number;
    state: TableFillJobSnapshot['state'] = 'running';
    private queue: RowPlan[];
    private inFlight = 0;
    private rowsDone = 0;
    private rowsFailed = 0;
    private requestRowsDone = 0;
    private charged = 0;
    private balanceAtStart: number | null;
    private stopReason?: TableFillNotStartedReason;
    /**
     * Plugin shutdown abandoned the job. From then on it has no effect
     * outside itself: its shutdown flush saves the answers already queued,
     * and whatever settles later (a request, a document read) is dropped —
     * no request, no write, no progress, no profile refresh. The plugin that
     * comes up next may share the runtime and the account.
     */
    private abandoned = false;
    private pendingCommit: PendingRow[] = [];
    private commitTimer?: ReturnType<typeof setTimeout>;
    private commitChain: Promise<void> = Promise.resolve();
    private seq = 0;
    private wakers = new Set<() => void>();
    private finished!: Promise<void>;
    private result: TableFillResult = {
        rows_answered: 0,
        answered: 0,
        not_reported: 0,
        from_title_abstract: 0,
        documents_read: 0,
        credits_charged: 0,
        row_failures: {},
        failed_row_ids: [],
        not_started: {},
        not_written: 0,
        skipped_cells: {},
        pending: null,
    };
    snapshot!: TableFillJobSnapshot;

    /** Rows the job works on: those it sends, and those it fails at the start. */
    readonly rowsTotal: number;

    constructor(
        private readonly owner: InstanceTableFills,
        private readonly deps: TableFillDeps,
        private readonly settings: TableFillSettings,
        readonly plan: StoredPlan,
        work: RowPlan[],
        private readonly initialRows: RowPlan[],
        readonly origin: TableFillOrigin,
        readonly generation: number,
        dropped: number,
    ) {
        this.id = deps.newId();
        this.startedAt = deps.now();
        this.queue = [...work];
        this.rowsTotal = work.length + initialRows.length;
        this.balanceAtStart = deps.account.balance();
        if (dropped) this.result.not_started.changed = dropped;
        this.refresh();
    }

    get running(): boolean {
        return this.state !== 'done';
    }

    get done(): Promise<void> {
        return this.finished;
    }

    private refresh(): void {
        const elapsed = (this.deps.now() - this.startedAt) / 1000;
        const remaining = this.queue.length + this.inFlight;
        const secondsLeft =
            this.requestRowsDone > 0 && remaining > 0
                ? Math.round((elapsed / this.requestRowsDone) * remaining)
                : remaining === 0
                  ? 0
                  : null;
        this.snapshot = {
            job_id: this.id,
            plan_id: this.plan.summary.plan_id,
            table: { ...this.plan.target, title: this.plan.table.title },
            origin: this.origin,
            state: this.state,
            rows_total: this.rowsTotal,
            rows_done: this.rowsDone,
            rows_failed: this.rowsFailed,
            in_flight: this.inFlight,
            credits_charged: round(this.charged),
            credits_planned: this.plan.summary.credits,
            balance: this.balanceAtStart == null ? null : round(Math.max(0, this.balanceAtStart - this.charged)),
            started_at: this.startedAt,
            seconds_left: secondsLeft,
            ...(this.state === 'done' ? { result: this.result } : {}),
        };
    }

    private publish(): void {
        this.refresh();
        if (this.abandoned) return;
        try {
            this.deps.publish(this.snapshot);
        } catch (error) {
            logger(`tableFills: publish failed: ${String(error)}`, 2);
        }
    }

    /**
     * May this job still send `row` off the device? The one check before a
     * row's document is read, after it is read, and at every HTTP dispatch
     * (each retry, and a resend after a token refresh): the plugin is not
     * shutting down, the account is the one that started the job, the
     * table can still be written (each request carries its title and
     * questions, and an answer that cannot be saved must not be paid for),
     * and neither the row's nor its document's library has been excluded.
     */
    private sendRefusal(row: RowPlan): Refusal | null {
        if (this.abandoned) return { scope: 'job', reason: 'shutdown' };
        if (this.deps.account.generation() !== this.generation || !this.deps.account.signedIn())
            return { scope: 'job', reason: 'account_changed' };
        // An answer that cannot be saved must not be paid for.
        if (this.deps.writeRefusal(this.plan.target)) return { scope: 'job', reason: 'unavailable' };
        // Every request carries the table's title, description and questions.
        if (!this.deps.contextSendable(this.plan.context)) return { scope: 'job', reason: 'unavailable' };
        if (!this.deps.rowSendable({ ref: row.ref })) return { scope: 'row', code: 'library_excluded' };
        if (!this.deps.contextSendable({ reference: row.reference, abstract: row.abstract }))
            return { scope: 'row', code: 'library_excluded' };
        if (row.mode === 'document' && row.document && !this.deps.documentSendable(row.document.id))
            return { scope: 'row', code: 'library_excluded' };
        return null;
    }

    /**
     * May this job still commit? The one check before a commit enters the
     * mutation queue, when the queue admits it, and inside the store just
     * before the write lands: the account is the one that started the job,
     * and the table can still be written. Shutdown does not refuse: its
     * flush commits the answers already received.
     */
    private commitRefusal(): Refusal | null {
        if (this.deps.account.generation() !== this.generation || !this.deps.account.signedIn())
            return { scope: 'job', reason: 'account_changed' };
        if (this.deps.writeRefusal(this.plan.target)) return { scope: 'job', reason: 'unavailable' };
        return null;
    }

    private assertMaySend(row: RowPlan): void {
        const refusal = this.sendRefusal(row);
        if (refusal) throw new JobRefused(refusal);
    }

    private assertMayCommit = (): void => {
        const refusal = this.commitRefusal();
        if (refusal) throw new JobRefused(refusal);
    };

    /**
     * Acts on a refusal for `row`: a row refusal fails the row; a job refusal
     * stops the job and leaves the row pending. Always means the row will not
     * be sent.
     */
    private refuse(row: RowPlan, refusal: Refusal): void {
        if (refusal.scope === 'row') {
            this.queueRowFailure(row, refusal.code);
            return;
        }
        this.stop(refusal.reason);
        this.addNotStarted(refusal.reason, 1);
    }

    /**
     * Runs the job: the start commit (planning's document changes, and the
     * failures of rows that cannot be sent), the rows, the last commit.
     */
    run(initial: TableMutation[]): Promise<void> {
        this.finished = this.execute(initial).catch((error) => {
            logger(`tableFills: job ${this.id} failed: ${String(error)}`, 1);
        }).finally(() => this.finish());
        return this.finished;
    }

    private async execute(initial: TableMutation[]): Promise<void> {
        this.publish();
        if (initial.length) {
            const skipped = await this.commitNow(initial, this.initialRows.length);
            if (!Array.isArray(skipped)) {
                this.stop(this.stopReason ?? 'unavailable');
                this.addNotStarted(this.stopReason ?? 'unavailable', this.initialRows.length);
                return;
            }
            // A row another writer gave other documents keeps them and is left
            // to the next fill: its update was skipped. So is a row removed.
            const changed = new Set(skipped.filter((skip) => !skip.column).map((skip) => skip.row));
            const before = this.queue.length;
            this.queue = this.queue.filter((row) => !changed.has(row.row));
            this.addNotStarted('changed', before - this.queue.length);
            for (const row of this.initialRows) {
                if (changed.has(row.row)) this.addNotStarted('changed', 1);
                else this.recordFailure(row.row, rowFailure(row.error ?? 'read_failed').code);
            }
            this.publish();
        }
        const workers: Promise<void>[] = [];
        for (let i = 0; i < Math.max(1, this.settings.concurrency); i++) workers.push(this.worker());
        await Promise.all(workers);
        await this.flush();
    }

    private async worker(): Promise<void> {
        for (;;) {
            if (this.stopReason || this.abandoned) return;
            const row = this.queue.shift();
            if (!row) return;
            this.inFlight += 1;
            this.publish();
            try {
                await this.processRow(row);
            } catch (error) {
                if (error instanceof JobRefused) {
                    this.refuse(row, error.refusal);
                } else {
                    // An unexpected error (a database lookup while reading the
                    // document): the row fails, retryable, rather than vanish
                    // from the result.
                    logger(`tableFills: row ${row.row} failed: ${String(error)}`, 1);
                    this.queueRowFailure(row, 'read_failed');
                }
            } finally {
                this.inFlight -= 1;
                this.publish();
            }
        }
    }

    private async processRow(planned: RowPlan): Promise<void> {
        this.assertMaySend(planned);
        // Reading the document is local and free; whether the row is still
        // wanted is decided after it, at the last moment before paying.
        const read =
            planned.mode === 'document' && planned.document ? await this.deps.readDocument(planned.document.id) : null;
        this.assertMaySend(planned);
        const row = await this.stillWanted(planned);
        if (!row) {
            this.addNotStarted('changed', 1);
            return;
        }
        let document: SerializedFillDocument | undefined;
        if (read && row.document) {
            if (!read.ok) {
                this.queueRowFailure(row, readFailureCode(read.code, read.contentKind ?? row.document.kind));
                return;
            }
            const kind = requestDocumentKind(read.contentKind);
            if (!kind) {
                this.queueRowFailure(row, 'unsupported_type');
                return;
            }
            document = { id: row.document.id, kind, json: read.json };
        }
        const price = rowPrice(row, this.plan.summary.prices);
        const body = fillRequestBody(
            {
                job_id: this.id,
                row_id: row.row,
                ...(this.origin.run ? { run: this.origin.run } : {}),
                price,
                table: this.plan.table,
                columns: row.columns.map((id) => this.plan.columns.get(id)!.request),
                row: { reference: row.reference, ...(row.abstract ? { abstract: row.abstract } : {}) },
            },
            document,
        );
        document = undefined;
        const response = await this.send(row, body);
        if (!response) return;
        this.applyResponse(row, response);
    }

    /** Posts the row, retrying with the same key; null when the row stays pending. */
    private async send(row: RowPlan, body: string): Promise<TableFillResponse | null> {
        for (let attempt = 0; ; attempt++) {
            const refusal = this.sendRefusal(row);
            if (refusal) {
                this.refuse(row, refusal);
                return null;
            }
            try {
                // The same check runs again at the dispatch itself, after the
                // body is compressed and credentials are ready.
                const response = await this.deps.fill(body, () => this.assertMaySend(row));
                if (this.abandoned) {
                    // Shutdown came while the request was out: its answer has
                    // nowhere to go.
                    this.result.not_written += 1;
                    return null;
                }
                return response;
            } catch (error) {
                if (error instanceof JobRefused) {
                    this.refuse(row, error.refusal);
                    return null;
                }
                // The transport refuses a request across an account change on
                // its own; read it as the job's refusal.
                const late = this.sendRefusal(row);
                if (late?.scope === 'job') {
                    this.refuse(row, late);
                    return null;
                }
                const failure = classifyFillError(error);
                if (failure.kind === 'retry') {
                    if (attempt < this.settings.maxRetries) {
                        logger(`tableFills: row ${row.row} ${failure.code}, retry ${attempt + 1}`, 2);
                        await this.sleep(failure.retryAfterMs ?? this.settings.retryDelayMs(attempt));
                        continue;
                    }
                    this.stop('unavailable');
                    this.addNotStarted('unavailable', 1);
                    return null;
                }
                if (failure.kind === 'stop') {
                    // The next plan must ask for the prices again.
                    if (failure.code === 'price_changed') this.owner.invalidatePricing();
                    const reason: TableFillNotStartedReason =
                        failure.code === 'signed_out' ? 'account_changed' : failure.code;
                    this.stop(reason);
                    this.addNotStarted(reason, 1);
                    return null;
                }
                logger(`tableFills: row ${row.row} refused (${failure.code}): ${failure.message}`, 1);
                this.queueRowFailure(row, failure.code === 'too_large' ? 'document_too_large' : 'request_refused');
                return null;
            }
        }
    }

    /**
     * The row as it may still be filled, checked against the table right
     * before its first request (after its document was read): without the columns whose question changed
     * or that became the user's, or another fill answered since. Null when
     * nothing of it is left (its row removed or moved to other documents), so
     * no request is paid for an answer that would be thrown away.
     */
    private async stillWanted(row: RowPlan): Promise<RowPlan | null> {
        let spec: TableSpec;
        try {
            spec = (await this.deps.readTable(this.plan.target)).spec;
        } catch {
            throw new JobRefused({ scope: 'job', reason: 'unavailable' });
        }
        const { rows } = validatePlan(
            {
                rows: [row],
                columns: this.plan.columns,
                // Planning's document changes were committed at the start.
                documentUpdates: [],
                selection: this.plan.selection,
                // A retried row was admitted at the start; its failure may
                // since have been cleared by its new document.
                summary: { scope: this.plan.summary.scope.kind === 'retry_failed' ? { kind: 'cells' } : this.plan.summary.scope },
            },
            spec,
        );
        return rows[0] ?? null;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const wake = () => {
                clearTimeout(timer);
                this.wakers.delete(wake);
                resolve();
            };
            const timer = setTimeout(wake, ms);
            this.wakers.add(wake);
        });
    }

    private applyResponse(row: RowPlan, response: TableFillResponse): void {
        this.charged += Number(response.charged) || 0;
        this.result.credits_charged = round(this.charged);
        this.requestRowsDone += 1;
        const writes: CellWrite[] = [];
        for (const columnId of row.columns) {
            const cell = response.cells?.[columnId] as Cell | undefined;
            if (!cell) continue;
            const column = this.plan.columns.get(columnId)!;
            writes.push({
                row: row.row,
                column: columnId,
                cell,
                question_hash: column.request.question_hash,
                revision: column.revision,
                expected_documents: row.documents,
            });
        }
        const failure = response.row_failure ?? null;
        const mutations: TableMutation[] = [];
        if (writes.length) mutations.push({ op: 'set_cells', cells: writes });
        mutations.push({
            op: 'update_row',
            row: row.row,
            failure: failure ? { code: failure.code, message: failure.message } : null,
            expected_documents: row.documents,
        });
        if (failure) {
            this.recordFailure(row.row, failure.code);
        } else {
            this.rowsDone += 1;
            if (row.mode === 'document') this.result.documents_read += 1;
        }
        // Answers are counted once their commit lands, less those it skipped.
        this.enqueueCommit(
            row.row,
            mutations,
            writes.map((write) => {
                const cell = write.cell as Cell;
                return { column: write.column, outcome: cell.outcome, fromTitleAbstract: !cell.documents?.length };
            }),
        );
    }

    /**
     * Counts the answers of committed rows that the commit did not skip, and
     * a row as answered once at least one of its answers landed.
     */
    private countWritten(entries: readonly PendingRow[], skipped: readonly SkippedCell[]): void {
        const declined = new Set(skipped.map((skip) => `${skip.row}\u0000${skip.column ?? ''}`));
        for (const entry of entries) {
            const written = entry.cells.filter((cell) => !declined.has(`${entry.row}\u0000${cell.column}`));
            if (written.length) this.result.rows_answered += 1;
            for (const cell of written) {
                if (cell.outcome === 'answered') {
                    this.result.answered += 1;
                    if (cell.fromTitleAbstract) this.result.from_title_abstract += 1;
                } else if (cell.outcome === 'not_reported') {
                    this.result.not_reported += 1;
                }
            }
        }
    }

    private recordFailure(rowId: string, code: string): void {
        this.rowsDone += 1;
        this.rowsFailed += 1;
        this.result.row_failures[code] = (this.result.row_failures[code] ?? 0) + 1;
        this.result.failed_row_ids.push(rowId);
    }

    private queueRowFailure(row: RowPlan, code: string): void {
        const failure = rowFailure(code);
        this.recordFailure(row.row, failure.code);
        this.enqueueCommit(row.row, [
            { op: 'update_row', row: row.row, failure, expected_documents: row.documents },
        ]);
    }

    private addNotStarted(reason: TableFillNotStartedReason, count: number): void {
        if (count <= 0) return;
        this.result.not_started[reason] = (this.result.not_started[reason] ?? 0) + count;
    }

    private enqueueCommit(row: string, mutations: TableMutation[], cells: PendingRow['cells'] = []): void {
        if (this.abandoned) return;
        this.pendingCommit.push({ row, mutations, cells });
        if (this.pendingCommit.length >= this.settings.commitRows) {
            void this.flush();
            return;
        }
        if (!this.commitTimer) {
            this.commitTimer = setTimeout(() => {
                this.commitTimer = undefined;
                void this.flush();
            }, this.settings.commitSeconds * 1000);
        }
    }

    /** Commits every waiting row; resolves once all commits so far have settled. */
    flush(): Promise<void> {
        if (this.commitTimer) {
            clearTimeout(this.commitTimer);
            this.commitTimer = undefined;
        }
        const batch = this.pendingCommit;
        this.pendingCommit = [];
        if (batch.length) {
            this.commitChain = this.commitChain.then(async () => {
                const landed = await this.commitNow(batch.flatMap((entry) => entry.mutations), 0);
                if (Array.isArray(landed)) {
                    this.countWritten(batch, landed);
                    return;
                }
                if (landed === 'failed' || batch.length === 1) {
                    this.result.not_written += batch.length;
                    return;
                }
                // The table refused the batch as a whole (an answer it cannot
                // hold): commit row by row, so one row does not cost the others.
                for (const entry of batch) {
                    const one = await this.commitNow(entry.mutations, 0);
                    if (Array.isArray(one)) this.countWritten([entry], one);
                    else this.result.not_written += 1;
                }
            });
        }
        return this.commitChain;
    }

    /**
     * One commit through the mutation queue and the store's session path.
     * Returns the skipped writes; `refused` when the table refused the
     * mutations, and `failed` when the commit could not run (the table gone,
     * the account changed), which stops the job. `finishing` rows are counted
     * as done in the version's description.
     */
    private async commitNow(mutations: TableMutation[], finishing: number): Promise<SkippedCell[] | 'refused' | 'failed'> {
        const total = this.rowsTotal;
        const done = this.rowsDone + finishing;
        try {
            this.assertMayCommit();
            const result = await this.deps.commit(
                this.plan.target,
                { operation_id: this.id, seq: ++this.seq, mutations },
                {
                    actor: 'agent',
                    collapse_key: this.id,
                    change: `Filled ${Math.min(done, total)} of ${total} ${total === 1 ? 'paper' : 'papers'}`,
                    ...(this.origin.run ? { run_id: this.origin.run.run_id, thread_id: this.origin.run.thread_id } : {}),
                },
                this.assertMayCommit,
            );
            if (!result.ok) {
                logger(`tableFills: commit refused for ${this.plan.target.key}: ${result.error.code} ${result.error.message}`, 1);
                return 'refused';
            }
            for (const skip of result.skipped) {
                if (!skip.column) continue;
                this.result.skipped_cells[skip.reason] = (this.result.skipped_cells[skip.reason] ?? 0) + 1;
            }
            return result.skipped;
        } catch (error) {
            logger(`tableFills: commit failed for ${this.plan.target.key}: ${String(error)}`, 1);
            const refusal =
                error instanceof JobRefused ? error.refusal : (this.commitRefusal() ?? { scope: 'job', reason: 'unavailable' });
            this.stop(refusal.scope === 'job' ? refusal.reason : 'unavailable');
            return 'failed';
        }
    }

    /** Starts no new rows; rows in flight finish and are written. */
    stop(reason: TableFillNotStartedReason = 'stopped'): void {
        if (this.state === 'done') return;
        if (!this.stopReason) this.stopReason = reason;
        if (this.state === 'running') this.state = 'stopping';
        this.addNotStarted(reason, this.queue.length);
        this.queue = [];
        this.publish();
    }

    /** Plugin shutdown: stop, abandon requests in flight, flush what has arrived. */
    async abandon(timeoutMs: number): Promise<void> {
        this.stop('shutdown');
        this.abandoned = true;
        for (const wake of [...this.wakers]) wake();
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            this.flush(),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
        if (timer) clearTimeout(timer);
    }

    private async finish(): Promise<void> {
        if (this.stopReason) this.result.stopped_by = this.stopReason;
        if (!this.abandoned) {
            try {
                const { spec } = await this.deps.readTable(this.plan.target);
                this.result.pending = pendingWork(spec);
            } catch {
                this.result.pending = null;
            }
        }
        this.state = 'done';
        this.owner.jobEnded(this);
        this.publish();
        if (this.charged > 0 && !this.abandoned) this.deps.account.refreshProfile();
    }
}

/** Fill plans and jobs for the plugin's lifetime. */
export class InstanceTableFills {
    private plans = new Map<string, StoredPlan>();
    /** Running jobs, and the last finished job of each table. */
    private jobs = new Map<string, FillJob>();
    /** Table key → the job holding its fill lease. */
    private leases = new Map<string, FillJob>();
    private finishedAt = new Map<string, number>();
    private pricingCache?: { generation: number; at: number; prices: Promise<TableFillPricing> };
    private unsubscribeAccount: () => void;
    private disposed = false;

    constructor(
        private readonly deps: TableFillDeps,
        readonly settings: TableFillSettings = { ...DEFAULT_TABLE_FILL_SETTINGS },
    ) {
        let generation = deps.account.generation();
        this.unsubscribeAccount = deps.account.subscribe(() => {
            const next = deps.account.generation();
            if (next === generation) return;
            generation = next;
            this.plans.clear();
            this.pricingCache = undefined;
            for (const job of this.leases.values()) job.stop('account_changed');
        });
    }

    /** The prices for this account, fetched when first needed and hourly after. */
    pricing(): Promise<TableFillPricing> {
        const generation = this.deps.account.generation();
        const cached = this.pricingCache;
        if (cached && cached.generation === generation && this.deps.now() - cached.at < PRICING_TTL_MS) return cached.prices;
        const prices = this.deps.pricing();
        const entry = { generation, at: this.deps.now(), prices };
        this.pricingCache = entry;
        void prices.catch(() => {
            if (this.pricingCache === entry) this.pricingCache = undefined;
        });
        return prices;
    }

    /** Forgets the fetched prices (the endpoint refused them as changed). */
    invalidatePricing(): void {
        this.pricingCache = undefined;
    }

    /** Builds a plan for `scope` and keeps it for {@link start}. */
    async plan(target: TableFillTarget, scope: TableFillScope = { kind: 'pending' }): Promise<TableFillPlanResult> {
        if (this.disposed || !this.deps.account.signedIn())
            return { ok: false, code: 'signed_out', message: 'Sign in to Beaver to fill tables.' };
        const generation = this.deps.account.generation();
        const refusal = this.deps.writeRefusal(target);
        if (refusal)
            return {
                ok: false,
                code: refusal,
                message: refusal === 'read_only' ? 'This library is read-only.' : 'The table is not available.',
            };
        let read: TableFillTableRead;
        try {
            read = await this.deps.readTable(target);
        } catch (error) {
            return { ok: false, code: 'table_unavailable', message: String((error as Error)?.message ?? error) };
        }
        const spec = read.spec;
        let selection: FillSelection;
        if (scope.kind === 'retry_failed') selection = { rows: retryableFailedRows(spec) };
        else if (scope.kind === 'cells') selection = { rows: scope.rows, columns: scope.columns };
        else selection = {};
        let prices: TableFillPricing;
        let lookups: Map<string, RowLookup>;
        let planned: ReturnType<typeof buildPlan>;
        try {
            const columns = selectedColumns(spec, selection.columns);
            const toLookUp = rowsToLookUp(spec, selection, columns);
            [prices, lookups] = await Promise.all([
                this.pricing().catch(() => null as unknown as TableFillPricing),
                this.deps.lookupRows(toLookUp),
            ]);
            planned = buildPlan(spec, selection, lookups);
        } catch (error) {
            if (error instanceof TableSelectionError) return { ok: false, code: error.code, message: error.message };
            throw error;
        }
        if (!prices) return { ok: false, code: 'pricing_unavailable', message: 'Could not get the price of a fill. Try again.' };
        if (generation !== this.deps.account.generation())
            return { ok: false, code: 'signed_out', message: 'The account changed while the fill was planned.' };
        // Every request carries the table's title, description and questions:
        // a reference in them to an excluded library's item stops the plan.
        const table = {
            title: (spec.title ?? '').slice(0, 1000),
            ...(spec.description ? { description: spec.description.slice(0, 20_000) } : {}),
        };
        const context = { table, columns: planned.columns.map((column) => column.request) };
        if (!this.deps.contextSendable(context))
            return {
                ok: false,
                code: 'table_unavailable',
                message: 'This table refers to items in a library Beaver cannot access, so it cannot be filled.',
            };
        // A row from an excluded library is never sent: it gets the failure.
        const byId = new Map(spec.rows.map((row) => [row.id, row]));
        for (const row of planned.rows) {
            const tableRow = byId.get(row.row);
            const documentExcluded = row.mode === 'document' && row.document && !this.deps.documentSendable(row.document.id);
            const fieldsExcluded = !this.deps.contextSendable({ reference: row.reference, abstract: row.abstract });
            if ((row.mode === 'document' || row.mode === 'metadata') && tableRow && (!this.deps.rowSendable(tableRow) || documentExcluded || fieldsExcluded)) {
                row.mode = 'unavailable';
                row.error = 'library_excluded';
                delete row.document;
            }
        }
        const count = (mode: RowPlan['mode']) => planned.rows.filter((row) => row.mode === mode).length;
        const credits = round(planned.rows.reduce((sum, row) => sum + rowPrice(row, prices), 0));
        const now = this.deps.now();
        const summary: TableFillPlanSummary = {
            plan_id: this.deps.newId(),
            table: { ...target, title: spec.title ?? '' },
            scope,
            rows: planned.rows.length,
            cells: planned.cells,
            documents: count('document'),
            document_kinds: documentKinds(planned.rows),
            title_abstract: count('metadata'),
            no_input: count('no_input'),
            unavailable: count('unavailable'),
            credits,
            prices: { ...prices },
            pending: pendingWork(spec),
            balance: this.deps.account.balance(),
            expires_at: now + this.settings.planTtlMs,
        };
        this.prunePlans();
        this.plans.set(summary.plan_id, {
            summary,
            generation,
            target: { ...target },
            table,
            context,
            selection: scope.kind === 'pending' ? {} : { rows: selection.rows, columns: selection.columns },
            rows: planned.rows,
            columns: new Map(planned.columns.map((column) => [column.request.id, column])),
            documentUpdates: planned.documentUpdates,
        });
        return { ok: true, plan: summary };
    }

    private prunePlans(): void {
        const now = this.deps.now();
        for (const [id, plan] of this.plans) if (plan.summary.expires_at <= now) this.plans.delete(id);
        for (const [id, at] of this.finishedAt) {
            if (now - at < this.settings.finishedTtlMs) continue;
            this.finishedAt.delete(id);
            this.jobs.delete(id);
        }
    }

    /**
     * Starts an approved plan. The plan is validated against the table as it
     * is now: cells whose row was removed or moved to other documents, whose
     * column changed, or that became the user's are dropped; nothing is added.
     */
    async start(planId: string, origin: TableFillOrigin = { kind: 'user' }): Promise<TableFillStartResult> {
        this.prunePlans();
        const plan = this.plans.get(planId);
        if (!plan) return { ok: false, code: 'plan_not_found', message: 'This fill plan is no longer available. Plan the fill again.' };
        if (plan.summary.expires_at <= this.deps.now()) {
            this.plans.delete(planId);
            return { ok: false, code: 'plan_expired', message: 'This fill plan has expired. Plan the fill again.' };
        }
        if (this.disposed || !this.deps.account.signedIn() || plan.generation !== this.deps.account.generation())
            return { ok: false, code: 'signed_out', message: 'The account changed since the fill was planned.' };
        const key = tableKey(plan.target);
        const holder = this.leases.get(key);
        if (holder) return { ok: false, code: 'fill_in_progress', message: 'This table is already being filled.', job_id: holder.id };
        const refusal = this.deps.writeRefusal(plan.target);
        if (refusal) return { ok: false, code: refusal, message: refusal === 'read_only' ? 'This library is read-only.' : 'The table is not available.' };
        let spec: TableSpec;
        try {
            spec = (await this.deps.readTable(plan.target)).spec;
        } catch (error) {
            return { ok: false, code: 'table_unavailable', message: String((error as Error)?.message ?? error) };
        }
        // Checked again after the read: shutdown, or another start taking the lease.
        if (this.disposed)
            return { ok: false, code: 'table_unavailable', message: 'Beaver is shutting down.' };
        if (!this.deps.account.signedIn() || plan.generation !== this.deps.account.generation())
            return { ok: false, code: 'signed_out', message: 'The account changed since the fill was planned.' };
        const raced = this.leases.get(key);
        if (raced) return { ok: false, code: 'fill_in_progress', message: 'This table is already being filled.', job_id: raced.id };
        if (!this.plans.has(planId))
            return { ok: false, code: 'plan_not_found', message: 'This fill plan is no longer available. Plan the fill again.' };

        const { rows, dropped } = validatePlan(plan, spec);
        if (!rows.length)
            return { ok: false, code: 'nothing_to_fill', message: 'Nothing in this plan is left to fill.' };
        // A plan runs once.
        this.plans.delete(planId);
        const kept = new Set(rows.map((row) => row.row));
        const initialRows = rows.filter((row) => row.mode === 'unavailable' || row.mode === 'no_input');
        const work = rows.filter((row) => row.mode === 'document' || row.mode === 'metadata');
        const initial: TableMutation[] = [];
        for (const update of plan.documentUpdates) {
            if (!kept.has(update.row)) continue;
            initial.push({ op: 'update_row', row: update.row, documents: update.documents, expected_documents: update.before });
        }
        for (const row of initialRows) {
            initial.push({ op: 'update_row', row: row.row, failure: rowFailure(row.error ?? 'read_failed'), expected_documents: row.documents });
        }
        const job = new FillJob(this, this.deps, this.settings, plan, work, initialRows, origin, plan.generation, dropped);
        this.jobs.set(job.id, job);
        this.leases.set(key, job);
        void job.run(initial);
        return { ok: true, job: job.snapshot };
    }

    /** Stops a job: no new rows; rows in flight finish. */
    stop(jobId: string): boolean {
        const job = this.jobs.get(jobId);
        if (!job || !job.running) return false;
        job.stop('stopped');
        return true;
    }

    getJob(jobId: string): TableFillJobSnapshot | null {
        return this.jobs.get(jobId)?.snapshot ?? null;
    }

    /** The table's running job, else its last finished one still shown. */
    jobForTable(target: TableFillTarget): TableFillJobSnapshot | null {
        this.prunePlans();
        const key = tableKey(target);
        const running = this.leases.get(key);
        if (running) return running.snapshot;
        let latest: FillJob | undefined;
        for (const job of this.jobs.values()) {
            if (tableKey(job.plan.target) !== key) continue;
            if (!latest || job.startedAt > latest.startedAt) latest = job;
        }
        return latest?.snapshot ?? null;
    }

    /** Forgets a finished job (its result banner was dismissed). */
    dismiss(jobId: string): void {
        const job = this.jobs.get(jobId);
        if (!job || job.running) return;
        this.jobs.delete(jobId);
        this.finishedAt.delete(jobId);
    }

    /** Resolves with the job's snapshot once it has ended, or after `timeoutMs`. */
    async wait(jobId: string, timeoutMs = 600_000): Promise<TableFillJobSnapshot | null> {
        const job = this.jobs.get(jobId);
        if (!job) return null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            job.done,
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
        if (timer) clearTimeout(timer);
        return job.snapshot;
    }

    /** @internal Called by a job when it ends. */
    jobEnded(job: FillJob): void {
        const key = tableKey(job.plan.target);
        if (this.leases.get(key) === job) this.leases.delete(key);
        // A table shows its last fill's result only: an earlier one would
        // come back once the latest is dismissed.
        for (const [id, other] of this.jobs) {
            if (other !== job && !other.running && tableKey(other.plan.target) === key) {
                this.jobs.delete(id);
                this.finishedAt.delete(id);
            }
        }
        this.finishedAt.set(job.id, this.deps.now());
    }

    /**
     * Plugin shutdown: stops every job, abandons requests in flight and
     * flushes the answers already received. Call before the mutation and
     * document services are disposed.
     */
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribeAccount();
        const running = [...this.leases.values()];
        await Promise.all(running.map((job) => job.abandon(this.settings.shutdownFlushMs)));
        this.plans.clear();
    }
}

/**
 * The plan's rows that may still start, with only the cells that may still be
 * written, and how many rows were dropped. A cell is dropped when its row was
 * removed or moved to other documents, its column changed, it became the
 * user's, or it is no longer selected: another fill answered it since the
 * plan was made. Nothing is ever added.
 */
export function validatePlan(
    plan: Pick<StoredPlan, 'rows' | 'columns' | 'documentUpdates' | 'selection'> & { summary: Pick<TableFillPlanSummary, 'scope'> },
    spec: TableSpec,
): { rows: RowPlan[]; dropped: number } {
    const columns = new Map(spec.columns.map((column) => [column.id, column]));
    const valid = new Set<string>();
    for (const [id, planned] of plan.columns) {
        const column = columns.get(id);
        if (!column) continue;
        if ((column.revision ?? 0) !== planned.revision) continue;
        if (questionHash(column) !== planned.request.question_hash) continue;
        valid.add(id);
    }
    const before = new Map(plan.documentUpdates.map((update) => [update.row, update.before]));
    const rowsById = new Map(spec.rows.map((row) => [row.id, row]));
    // The selection again, on the table as it is now, seen with the documents
    // the plan gives its rows.
    const updates: TableMutation[] = plan.documentUpdates.map((update) => ({
        op: 'update_row',
        row: update.row,
        documents: update.documents,
        expected_documents: update.before,
    }));
    const applied = updates.length ? applyMutations(spec, updates, { skipMissing: true }) : null;
    const planning = applied?.ok ? applied.spec : spec;
    const selectedRows = plan.selection.rows?.filter((id) => rowsById.has(id));
    const selectedColumns = (plan.selection.columns ?? [...plan.columns.keys()]).filter((id) => valid.has(id));
    const selected = new Set(
        selectedColumns.length
            ? cellsToFill(planning, { rows: selectedRows, columns: selectedColumns }).map(([row, column]) => `${row}\u0000${column}`)
            : [],
    );
    const retryOnly = plan.summary.scope.kind === 'retry_failed';
    const rows: RowPlan[] = [];
    let dropped = 0;
    for (const planned of plan.rows) {
        const row = rowsById.get(planned.row);
        const expected = before.get(planned.row) ?? planned.documents;
        if (!row || !sameDocuments(row.documents, expected) || (retryOnly && row.failure == null && !before.has(planned.row))) {
            dropped += 1;
            continue;
        }
        const keep = planned.columns.filter(
            (id) => valid.has(id) && row.cells[id]?.provenance !== 'user' && selected.has(`${planned.row}\u0000${id}`),
        );
        if (!keep.length) {
            dropped += 1;
            continue;
        }
        rows.push(keep.length === planned.columns.length ? planned : { ...planned, columns: keep });
    }
    return { rows, dropped };
}

export { TABLE_FILL_CHANGED_EVENT };
