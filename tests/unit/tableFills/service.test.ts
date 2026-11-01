/**
 * The fill job against fake dependencies: an in-memory table changed by the
 * real mutation engine, a scripted endpoint, a fake account.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Cell, Row, TableSpec } from "@beaver/agent-core/layouts/table";
import { applyMutations, type TableMutation } from "@beaver/agent-core/layouts/tableMutations";
import { ApiError, SessionRefreshError } from "@beaver/agent-core/types/apiErrors";
import type {
    TableFillJobSnapshot,
    TableFillRequest,
    TableFillResponse,
} from "@beaver/agent-core/protocol/tableFillProtocol";
import {
    DEFAULT_TABLE_FILL_SETTINGS,
    InstanceTableFills,
    type TableFillDeps,
    type TableFillDocumentRead,
} from "../../../src/services/tableFills/service";
import type { RowLookup } from "../../../src/services/tableFills/planner";
import type { ArtifactRequest } from "@beaver/agent-core/protocol/artifactProtocol";
import type { AgentDataRequestContext } from "@beaver/agent-core/transport/agentDataDispatch";

vi.mock("@beaver/agent-core/platform/logger", () => ({ logger: vi.fn() }));

const TARGET = { libraryID: 1, key: "TABLE001" };

function itemRow(id: string, extra: Partial<Row> = {}): Row {
    return {
        id,
        ref: { kind: "item", library_ref: "u", zotero_key: `K${id.toUpperCase()}`.padEnd(8, "X") },
        ...extra,
        cells: {
            _reference: { outcome: "answered", provenance: "system", value: { kind: "reference", display_name: id, title: `Paper ${id}` } },
            ...(extra.cells ?? {}),
        },
    };
}

function makeTable(rows: Row[]): TableSpec {
    return {
        id: "t",
        title: "Trials",
        columns: [
            { id: "_reference", header: "Reference", type: "reference", system: true },
            { id: "method", header: "Method", type: "text", description: "What method?" },
            {
                id: "design",
                header: "Design",
                type: "select",
                description: "Which design?",
                options: [{ label: "RCT", color: "blue" }, { label: "Observational", color: "green" }],
            },
        ],
        rows,
    };
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** A model answer for every column a request asks. */
function answer(request: TableFillRequest): TableFillResponse {
    const cells: Record<string, Cell> = {};
    for (const column of request.columns) {
        const value = column.type === "select" ? ({ kind: "select", label: "RCT" } as const) : ({ kind: "text", text: `answer ${request.row_id}` } as const);
        cells[column.id] = request.document
            ? { outcome: "answered", provenance: "model", value, documents: [request.document.id] }
            : { outcome: "answered", provenance: "model", value };
    }
    return { cells, row_failure: null, charged: request.price };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(check: () => boolean, label = "condition"): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (check()) return;
        await flush();
    }
    throw new Error(`timed out waiting for ${label}`);
}

function harness(
    rows: Row[],
    options: { lookups?: Record<string, RowLookup>; balance?: number | null; agentWaitMs?: () => number; now?: () => number } = {},
) {
    const state = {
        table: makeTable(rows),
        generation: 1,
        requests: [] as TableFillRequest[],
        bodies: [] as string[],
        commits: [] as { mutations: TableMutation[]; meta: Record<string, unknown> }[],
        snapshots: [] as TableFillJobSnapshot[],
        excluded: new Set<string>(),
        signedIn: true,
        documents: {} as Record<string, TableFillDocumentRead>,
        respond: (request: TableFillRequest): Promise<TableFillResponse> => Promise.resolve(answer(request)),
    };
    const listeners = new Set<() => void>();
    let id = 0;
    const deps: TableFillDeps = {
        readTable: async () => ({ spec: structuredClone(state.table), version: 1 }),
        writeRefusal: () => null,
        lookupRows: async (looked) => {
            const map = new Map<string, RowLookup>();
            for (const row of looked) {
                map.set(row.id, options.lookups?.[row.id] ?? { documents: [{ id: `u-PDF${row.id}`, kind: "pdf", primary: true }], abstract: "An abstract." });
            }
            return map;
        },
        rowSendable: (row) => !(row.ref?.kind === "item" && state.excluded.has(row.ref.zotero_key)),
        documentSendable: (documentId) => !state.excluded.has(documentId),
        // Text naming an item of an excluded library, by its key.
        contextSendable: (value) => ![...state.excluded].some((key) => JSON.stringify(value).includes(key)),
        readDocument: async (documentId) => state.documents[documentId] ?? { ok: true, json: `{"doc":"${documentId}"}`, contentKind: "pdf" },
        pricing: async () => ({ document: 0.2, title_abstract: 0.05 }),
        fill: async (body, assertDispatch) => {
            assertDispatch();
            const request = JSON.parse(body) as TableFillRequest;
            state.requests.push(request);
            state.bodies.push(body);
            return state.respond(request);
        },
        commit: async (_target, commit, meta, assertCurrent) => {
            assertCurrent();
            const result = applyMutations(state.table, commit.mutations, { skipMissing: true });
            state.commits.push({ ...commit, meta });
            if (!result.ok) return { ok: false, error: result.error };
            state.table = result.spec;
            return { ok: true, skipped: result.skipped };
        },
        account: {
            generation: () => state.generation,
            signedIn: () => state.signedIn,
            balance: () => (options.balance === undefined ? 10 : options.balance),
            subscribe: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            refreshProfile: vi.fn(),
        },
        publish: (snapshot) => state.snapshots.push(snapshot),
        newId: () => `id-${++id}`,
        now: options.now ?? (() => Date.now()),
    };
    const fills = new InstanceTableFills(
        deps,
        {
            ...DEFAULT_TABLE_FILL_SETTINGS,
            concurrency: 1,
            commitSeconds: 3600,
            retryDelayMs: () => 0,
        },
        options.agentWaitMs,
    );
    const switchAccount = () => {
        state.generation += 1;
        for (const listener of [...listeners]) listener();
    };
    return { state, deps, fills, switchAccount };
}

async function planAndStart(fills: InstanceTableFills) {
    const planned = await fills.plan(TARGET);
    if (!planned.ok) throw new Error(planned.message);
    const started = await fills.start(planned.plan.plan_id);
    if (!started.ok) throw new Error(started.message);
    return { plan: planned.plan, job: started.job };
}

describe("planning", () => {
    it("prices the plan per row, from the document or from title and abstract", async () => {
        const { fills } = harness([itemRow("a"), itemRow("b"), itemRow("c")], {
            lookups: {
                b: { documents: [], abstract: "Only an abstract." },
                c: { documents: [], abstract: "" },
            },
        });
        const planned = await fills.plan(TARGET);
        expect(planned.ok && planned.plan).toMatchObject({
            rows: 3,
            documents: 1,
            title_abstract: 1,
            no_input: 1,
            credits: 0.25,
            prices: { document: 0.2, title_abstract: 0.05 },
            balance: 10,
            document_kinds: { pdf: 1 },
        });
    });

    it("never sends a row from an excluded library: it gets the failure, at no cost", async () => {
        const { state, fills } = harness([itemRow("a"), itemRow("b")]);
        state.excluded.add(state.table.rows[1].ref!.kind === "item" ? (state.table.rows[1].ref as { zotero_key: string }).zotero_key : "");
        const { plan, job } = await planAndStart(fills);
        expect(plan).toMatchObject({ rows: 2, documents: 1, unavailable: 1, credits: 0.2 });
        const done = await fills.wait(job.job_id);
        expect(state.requests.map((r) => r.row_id)).toEqual(["a"]);
        expect(state.table.rows[1].failure?.code).toBe("library_excluded");
        expect(done?.result?.row_failures).toEqual({ library_excluded: 1 });
    });
});

describe("a fill", () => {
    it("writes each answer with the planned revision, question hash and documents, and charges per row", async () => {
        const { state, fills, deps } = harness([itemRow("a"), itemRow("b")]);
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(done?.state).toBe("done");
        expect(done?.result).toMatchObject({ rows_answered: 2, answered: 4, documents_read: 2, credits_charged: 0.4, not_written: 0 });
        expect(done?.balance).toBe(9.6);
        expect(state.table.rows.map((row) => row.documents)).toEqual([["u-PDFa"], ["u-PDFb"]]);
        expect(state.table.rows[0].cells.method?.value).toEqual({ kind: "text", text: "answer a" });
        // The start commit records the documents, expecting the previous ones.
        expect(state.commits[0].mutations).toEqual([
            { op: "update_row", row: "a", documents: ["u-PDFa"], expected_documents: [] },
            { op: "update_row", row: "b", documents: ["u-PDFb"], expected_documents: [] },
        ]);
        const write = (state.commits[1].mutations[0] as Extract<TableMutation, { op: "set_cells" }>).cells[0];
        expect(write).toMatchObject({ row: "a", column: "method", revision: 0, expected_documents: ["u-PDFa"] });
        expect(write.question_hash).toMatch(/^[0-9a-f]{16}$/);
        // Every commit collapses under the job's key.
        expect(new Set(state.commits.map((c) => c.meta.collapse_key))).toEqual(new Set([job.job_id]));
        expect(state.commits).toHaveLength(2);
        expect(state.requests[0]).toMatchObject({ job_id: job.job_id, row_id: "a", price: 0.2, table: { title: "Trials" }, document: { id: "u-PDFa", kind: "pdf", content: { doc: "u-PDFa" } } });
        expect(deps.account.refreshProfile).toHaveBeenCalledTimes(1);
        // The lease is released.
        expect(fills.jobForTable(TARGET)?.state).toBe("done");
    });

    it("commits every ten answered rows, and the rest at the end", async () => {
        const rows = Array.from({ length: 23 }, (_, i) => itemRow(`r${i}`, { documents: [`u-PDFr${i}`] }));
        const { state, fills } = harness(rows);
        const { job } = await planAndStart(fills);
        await fills.wait(job.job_id);
        const sizes = state.commits.map((c) => c.mutations.filter((m) => m.op === "update_row").length);
        expect(sizes).toEqual([10, 10, 3]);
    });

    it("answers a row without a document from its title and abstract at that price", async () => {
        const { state, fills } = harness([itemRow("a")], { lookups: { a: { documents: [], abstract: "We study meals." } } });
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(state.requests[0]).toMatchObject({ price: 0.05, row: { abstract: "We study meals." } });
        expect(state.requests[0].document).toBeUndefined();
        expect(done?.result).toMatchObject({ from_title_abstract: 2, documents_read: 0 });
    });

    it("fails a row whose document cannot be read, without a request or a charge", async () => {
        const { state, fills } = harness([itemRow("a"), itemRow("b")]);
        state.documents["u-PDFa"] = { ok: false, code: "encrypted", contentKind: "pdf" };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(state.requests.map((r) => r.row_id)).toEqual(["b"]);
        expect(state.table.rows[0].failure).toEqual({ code: "encrypted", message: "The PDF is password-protected." });
        expect(done?.result).toMatchObject({ row_failures: { encrypted: 1 }, credits_charged: 0.2, failed_row_ids: ["a"] });
    });

    it("fails a row whose document read throws, so it is reported and retried", async () => {
        const { state, fills, deps } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        deps.readDocument = async () => {
            throw new Error("database is locked");
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(state.requests).toHaveLength(0);
        expect(state.table.rows[0].failure?.code).toBe("read_failed");
        expect(done).toMatchObject({ rows_done: 1, rows_failed: 1, result: { row_failures: { read_failed: 1 }, failed_row_ids: ["a"] } });
    });

    it("writes the backend's row failure and clears an earlier one on an answer", async () => {
        const { state, fills } = harness([itemRow("a", { failure: { code: "deadline", message: "x" } }), itemRow("b")]);
        state.respond = async (request) =>
            request.row_id === "b" ? { cells: {}, row_failure: { code: "no_answer", message: "No answer could be produced." }, charged: 0 } : answer(request);
        const { job } = await planAndStart(fills);
        await fills.wait(job.job_id);
        expect(state.table.rows[0].failure).toBeUndefined();
        expect(state.table.rows[1].failure?.code).toBe("no_answer");
    });
});

describe("committing", () => {
    it("commits row by row when the table refuses a batch, so one bad answer costs only its row", async () => {
        const rows = Array.from({ length: 3 }, (_, i) => itemRow(`r${i}`, { documents: [`u-PDFr${i}`] }));
        const { state, fills } = harness(rows);
        fills.settings.commitRows = 3;
        state.respond = async (request) => {
            const response = answer(request);
            // A cell the table cannot hold: evidence from a document the cell does not name.
            if (request.row_id === "r1")
                response.cells.method = { ...response.cells.method, evidence: [{ document: "u-ELSEWHERE", locator: "s1", quote: "q" }] } as Cell;
            return response;
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(state.table.rows.map((row) => !!row.cells.method)).toEqual([true, false, true]);
        expect(done?.result).toMatchObject({ not_written: 1, rows_answered: 2 });
    });
});

describe("exclusions", () => {
    it("rechecks the row's library at dispatch: one excluded during extraction is never sent", async () => {
        const { state, fills, deps } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        const key = (state.table.rows[0].ref as { zotero_key: string }).zotero_key;
        const read = deps.readDocument;
        deps.readDocument = async (id) => {
            state.excluded.add(key);
            return read(id);
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(state.requests).toHaveLength(0);
        expect(state.table.rows[0].failure?.code).toBe("library_excluded");
        expect(done?.result).toMatchObject({ rows_answered: 0, credits_charged: 0 });
    });
});

describe("exclusions of a document", () => {
    it("never sends a document whose library was excluded, even when the row's is not", async () => {
        const { state, fills, deps } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        const read = deps.readDocument;
        deps.readDocument = async (id) => {
            state.excluded.add("u-PDFa");
            return read(id);
        };
        const { job } = await planAndStart(fills);
        await fills.wait(job.job_id);
        expect(state.requests).toHaveLength(0);
        expect(state.table.rows[0].failure?.code).toBe("library_excluded");
    });
});

describe("shutdown during a start", () => {
    it("admits no job once disposal began while the table was read", async () => {
        const { fills, deps } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        const planned = await fills.plan(TARGET);
        if (!planned.ok) throw new Error(planned.message);
        const read = deps.readTable;
        const gate = deferred<void>();
        deps.readTable = async (target) => {
            await gate.promise;
            return read(target);
        };
        const starting = fills.start(planned.plan.plan_id);
        await fills.dispose();
        gate.resolve();
        expect(await starting).toMatchObject({ ok: false });
        expect(fills.jobForTable(TARGET)).toBeNull();
    });
});

describe("the send and commit checks", () => {
    it("sends nothing more once the user is signed out, even before the account generation moves", async () => {
        const rows = Array.from({ length: 3 }, (_, i) => itemRow(`r${i}`, { documents: [`u-PDFr${i}`] }));
        const { state, fills } = harness(rows);
        state.respond = async (request) => {
            state.signedIn = false;
            return answer(request);
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(state.requests).toHaveLength(1);
        // The answer that arrived is not committed for a signed-out account.
        expect(state.table.rows.every((row) => !row.cells.method)).toBe(true);
        expect(done?.result).toMatchObject({ stopped_by: "account_changed", not_written: 1 });
    });

    it("commits nothing once the table's library became read-only, and stops", async () => {
        const rows = Array.from({ length: 3 }, (_, i) => itemRow(`r${i}`, { documents: [`u-PDFr${i}`] }));
        const { state, fills, deps } = harness(rows);
        fills.settings.commitRows = 1;
        let readOnly = false;
        deps.writeRefusal = () => (readOnly ? "read_only" : null);
        state.respond = async (request) => {
            readOnly = true;
            return answer(request);
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        // No further row is sent once its answer could not be saved.
        expect(state.requests).toHaveLength(1);
        expect(state.table.rows.every((row) => !row.cells.method)).toBe(true);
        expect(done?.result).toMatchObject({ stopped_by: "unavailable", not_written: 1 });
    });

    it("runs the commit check inside the store, after the queue admitted the commit", async () => {
        const { state, fills, deps } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        const commit = deps.commit;
        deps.commit = async (target, request, meta, mayCommit) => {
            // The account changes while the commit waits in the queue.
            if (request.mutations.some((m) => m.op === "set_cells")) state.generation += 1;
            return commit(target, request, meta, mayCommit);
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(state.table.rows[0].cells.method).toBeUndefined();
        expect(done?.result).toMatchObject({ stopped_by: "account_changed", not_written: 1 });
    });
});

describe("the table context bound for the backend", () => {
    it("refuses to plan a table whose questions name an item of an excluded library", async () => {
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        state.table.columns[1].description = "Compare with u-EXCLUDED.";
        state.excluded.add("u-EXCLUDED");
        expect(await fills.plan(TARGET)).toMatchObject({ ok: false, code: "table_unavailable" });
    });

    it("stops sending once the table's context names an item of a library excluded mid-fill", async () => {
        const rows = Array.from({ length: 3 }, (_, i) => itemRow(`r${i}`, { documents: [`u-PDFr${i}`] }));
        const { state, fills } = harness(rows);
        state.table.description = "Builds on u-LATERXCL.";
        state.respond = async (request) => {
            state.excluded.add("u-LATERXCL");
            return answer(request);
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(state.requests).toHaveLength(1);
        expect(done?.result).toMatchObject({ stopped_by: "unavailable" });
    });

    it("never sends a row whose own fields name an item of an excluded library", async () => {
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"] }), itemRow("b", { documents: ["u-PDFb"] })]);
        (state.table.rows[0].cells._reference!.value as { title?: string }).title = "A reply to u-EXCLROW1";
        state.excluded.add("u-EXCLROW1");
        const { job } = await planAndStart(fills);
        await fills.wait(job.job_id);
        expect(state.requests.map((r) => r.row_id)).toEqual(["b"]);
        expect(state.table.rows[0].failure?.code).toBe("library_excluded");
    });
});

describe("results", () => {
    it("counts a row as filled only when an answer of it was saved", async () => {
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        state.respond = async (request) => {
            const response = answer(request);
            response.cells.method = { ...response.cells.method, evidence: [{ document: "u-ELSEWHERE", locator: "s1", quote: "q" }] } as Cell;
            return response;
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(done?.result).toMatchObject({ rows_answered: 0, answered: 0, not_written: 1 });
    });

    it("counts only the answers a commit wrote", async () => {
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        const gate = deferred<void>();
        state.respond = async (request) => {
            await gate.promise;
            return answer(request);
        };
        const { job } = await planAndStart(fills);
        await until(() => state.requests.length === 1, "the request");
        const edited = applyMutations(state.table, [{ op: "update_column", column: "method", description: "Another question" }]);
        if (!edited.ok) throw new Error(edited.error.message);
        state.table = edited.spec;
        gate.resolve();
        const done = await fills.wait(job.job_id);
        expect(done?.result).toMatchObject({ answered: 1, skipped_cells: { column_changed: 1 } });
    });

    it("keeps only the table's last result, so a dismissed one does not bring back an older one", async () => {
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"] }), itemRow("b", { documents: ["u-PDFb"] })]);
        const first = await planAndStart(fills);
        await fills.wait(first.job.job_id);
        const edited = applyMutations(state.table, [{ op: "update_column", column: "method", description: "Again?" }]);
        if (!edited.ok) throw new Error(edited.error.message);
        state.table = edited.spec;
        const second = await planAndStart(fills);
        await fills.wait(second.job.job_id);
        expect(fills.getJob(first.job.job_id)).toBeNull();
        fills.dismiss(second.job.job_id);
        expect(fills.jobForTable(TARGET)).toBeNull();
    });
});

describe("starting a plan", () => {
    it("drops cells another fill answered after the plan was made", async () => {
        const { fills } = harness([itemRow("a", { documents: ["u-PDFa"] }), itemRow("b", { documents: ["u-PDFb"] })]);
        const stale = await fills.plan(TARGET);
        if (!stale.ok) throw new Error(stale.message);
        const other = await planAndStart(fills);
        await fills.wait(other.job.job_id);
        expect(await fills.start(stale.plan.plan_id)).toMatchObject({ ok: false, code: "nothing_to_fill" });
    });

    it("drops a row removed and a question changed after planning, and never adds a row", async () => {
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"] }), itemRow("b", { documents: ["u-PDFb"] })]);
        const planned = await fills.plan(TARGET);
        if (!planned.ok) throw new Error(planned.message);
        const edited = applyMutations(state.table, [
            { op: "remove_rows", rows: ["b"] },
            { op: "update_column", column: "method", description: "Which method, exactly?" },
            { op: "add_rows", rows: [itemRow("c", { documents: ["u-PDFc"] })] },
        ]);
        if (!edited.ok) throw new Error(edited.error.message);
        state.table = edited.spec;
        const started = await fills.start(planned.plan.plan_id);
        if (!started.ok) throw new Error(started.message);
        const done = await fills.wait(started.job.job_id);
        expect(state.requests.map((r) => [r.row_id, r.columns.map((c) => c.id)])).toEqual([["a", ["design"]]]);
        expect(done?.result?.not_started).toEqual({ changed: 1 });
        expect(state.table.rows.find((row) => row.id === "c")!.cells.design).toBeUndefined();
    });

    it("runs a plan once and refuses a second fill of the same table", async () => {
        const { state, fills } = harness([itemRow("a")]);
        const gate = deferred<TableFillResponse>();
        state.respond = () => gate.promise;
        const first = await fills.plan(TARGET);
        const second = await fills.plan(TARGET);
        if (!first.ok || !second.ok) throw new Error("plan failed");
        const started = await fills.start(first.plan.plan_id);
        expect(started.ok).toBe(true);
        expect(await fills.start(first.plan.plan_id)).toMatchObject({ ok: false, code: "plan_not_found" });
        const refused = await fills.start(second.plan.plan_id);
        expect(refused).toMatchObject({ ok: false, code: "fill_in_progress", job_id: started.ok ? started.job.job_id : "" });
        await until(() => state.requests.length === 1, "the request");
        gate.resolve(answer(state.requests[0]));
        await fills.wait(started.ok ? started.job.job_id : "");
    });
});

describe("edits during a fill", () => {
    it("skips a row removed mid-fill and lands the rest", async () => {
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"] }), itemRow("b", { documents: ["u-PDFb"] })]);
        const gate = deferred<void>();
        state.respond = async (request) => {
            if (request.row_id === "a") await gate.promise;
            return answer(request);
        };
        const { job } = await planAndStart(fills);
        await until(() => state.requests.length === 1, "the first request");
        const edited = applyMutations(state.table, [{ op: "remove_rows", rows: ["a"] }]);
        if (!edited.ok) throw new Error(edited.error.message);
        state.table = edited.spec;
        gate.resolve();
        const done = await fills.wait(job.job_id);
        expect(state.table.rows.map((row) => row.id)).toEqual(["b"]);
        expect(state.table.rows[0].cells.method).toBeDefined();
        expect(done?.result?.skipped_cells).toEqual({ row_removed: 2 });
    });

    it("sends no queued row with a question changed while the fill ran", async () => {
        const rows = Array.from({ length: 4 }, (_, i) => itemRow(`r${i}`, { documents: [`u-PDFr${i}`] }));
        const { state, fills } = harness(rows);
        state.respond = async (request) => {
            if (state.requests.length === 1) {
                const edited = applyMutations(state.table, [{ op: "update_column", column: "method", description: "A new question?" }]);
                if (!edited.ok) throw new Error(edited.error.message);
                state.table = edited.spec;
            }
            return answer(request);
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        // The rows still queued ask only the unchanged column.
        expect(state.requests.map((r) => r.columns.map((c) => c.id))).toEqual([["method", "design"], ["design"], ["design"], ["design"]]);
        expect(done?.result?.skipped_cells).toEqual({ column_changed: 1 });
    });

    it("sends nothing for a row removed while its document was being read", async () => {
        const { state, fills, deps } = harness([itemRow("a", { documents: ["u-PDFa"] }), itemRow("b", { documents: ["u-PDFb"] })]);
        const read = deps.readDocument;
        deps.readDocument = async (id) => {
            if (id === "u-PDFa") {
                const edited = applyMutations(state.table, [{ op: "remove_rows", rows: ["a"] }]);
                if (!edited.ok) throw new Error(edited.error.message);
                state.table = edited.spec;
            }
            return read(id);
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(state.requests.map((r) => r.row_id)).toEqual(["b"]);
        expect(done?.result).toMatchObject({ credits_charged: 0.2, not_started: { changed: 1 } });
    });

    it("never writes an answer back after its option was renamed (column_changed)", async () => {
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        const gate = deferred<void>();
        state.respond = async (request) => {
            await gate.promise;
            return answer(request);
        };
        const { job } = await planAndStart(fills);
        await until(() => state.requests.length === 1, "the request");
        const renamed = applyMutations(state.table, [
            { op: "update_column", column: "design", options: [{ label: "Randomized trial" }, { label: "Observational" }] },
        ]);
        if (!renamed.ok) throw new Error(renamed.error.message);
        state.table = renamed.spec;
        gate.resolve();
        const done = await fills.wait(job.job_id);
        const design = state.table.columns.find((c) => c.id === "design")!;
        expect(design.options!.map((o) => o.label)).toEqual(["Randomized trial", "Observational"]);
        expect(state.table.rows[0].cells.design).toBeUndefined();
        expect(state.table.rows[0].cells.method).toBeDefined();
        expect(done?.result?.skipped_cells).toEqual({ column_changed: 1 });
    });

    it("skips an answer for a row whose document changed meanwhile", async () => {
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        const gate = deferred<void>();
        state.respond = async (request) => {
            await gate.promise;
            return answer(request);
        };
        const { job } = await planAndStart(fills);
        await until(() => state.requests.length === 1, "the request");
        const moved = applyMutations(state.table, [{ op: "update_row", row: "a", documents: ["u-OTHER"] }]);
        if (!moved.ok) throw new Error(moved.error.message);
        state.table = moved.spec;
        gate.resolve();
        const done = await fills.wait(job.job_id);
        expect(state.table.rows[0].cells.method).toBeUndefined();
        expect(done?.result?.skipped_cells).toEqual({ documents_changed: 2 });
    });
});

describe("stopping", () => {
    it("starts no new rows and writes the rows in flight", async () => {
        const rows = Array.from({ length: 6 }, (_, i) => itemRow(`r${i}`, { documents: [`u-PDFr${i}`] }));
        const { state, fills } = harness(rows);
        fills.settings.concurrency = 3;
        const gates: Deferred<void>[] = [];
        state.respond = async (request) => {
            const gate = deferred<void>();
            gates.push(gate);
            await gate.promise;
            return answer(request);
        };
        const { job } = await planAndStart(fills);
        await until(() => state.requests.length === 3, "three rows in flight");
        expect(fills.stop(job.job_id)).toBe(true);
        expect(fills.getJob(job.job_id)?.state).toBe("stopping");
        for (const gate of gates) gate.resolve();
        const done = await fills.wait(job.job_id);
        expect(state.requests).toHaveLength(3);
        expect(done?.result).toMatchObject({ rows_answered: 3, credits_charged: 0.6, stopped_by: "stopped", not_started: { stopped: 3 } });
        expect(state.table.rows.filter((row) => row.cells.method).length).toBe(3);
    });
});

describe("failed requests", () => {
    it("retries a network error and a 429 with the same key and the same body", async () => {
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        let calls = 0;
        state.respond = async (request) => {
            calls += 1;
            if (calls === 1) throw new SessionRefreshError("Network request failed", 0, "Network Error");
            if (calls === 2) throw new ApiError(429, "Too Many Requests", "rate_limited", "rate_limited");
            return answer(request);
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(state.bodies).toHaveLength(3);
        expect(new Set(state.bodies).size).toBe(1);
        expect(done?.result).toMatchObject({ rows_answered: 1, credits_charged: 0.2 });
    });

    it("retries a 503, and stops the job when the server stays unavailable", async () => {
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"] }), itemRow("b", { documents: ["u-PDFb"] })]);
        fills.settings.maxRetries = 2;
        state.respond = async () => {
            throw new ApiError(503, "Service Unavailable", "unavailable", "unavailable");
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(state.requests.map((r) => r.row_id)).toEqual(["a", "a", "a"]);
        expect(done?.result).toMatchObject({ stopped_by: "unavailable", not_started: { unavailable: 2 } });
        expect(state.table.rows.every((row) => !row.failure)).toBe(true);
    });

    it("stops on 402: rows in flight finish, the rest stay pending", async () => {
        const rows = Array.from({ length: 5 }, (_, i) => itemRow(`r${i}`, { documents: [`u-PDFr${i}`] }));
        const { state, fills } = harness(rows);
        fills.settings.concurrency = 2;
        const held = deferred<void>();
        state.respond = async (request) => {
            if (request.row_id === "r0") {
                await held.promise;
                return answer(request);
            }
            throw new ApiError(402, "Payment Required", "insufficient_credits", "insufficient_credits");
        };
        const { job } = await planAndStart(fills);
        await until(() => fills.getJob(job.job_id)?.state === "stopping", "the stop");
        held.resolve();
        const done = await fills.wait(job.job_id);
        expect(state.requests.map((r) => r.row_id)).toEqual(["r0", "r1"]);
        expect(done?.result).toMatchObject({ rows_answered: 1, stopped_by: "insufficient_credits", not_started: { insufficient_credits: 4 } });
        expect(state.table.rows[0].cells.method).toBeDefined();
        expect(state.table.rows.slice(1).every((row) => !row.cells.method && !row.failure)).toBe(true);
    });

    it("stops on price_changed before anything is charged", async () => {
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"] }), itemRow("b", { documents: ["u-PDFb"] })]);
        state.respond = async () => {
            throw new ApiError(409, "Conflict", "price_changed", "price_changed");
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(state.requests).toHaveLength(1);
        expect(done?.result).toMatchObject({ credits_charged: 0, stopped_by: "price_changed", not_started: { price_changed: 2 } });
    });

    it("asks for the prices again after the endpoint refused them as changed", async () => {
        const { state, fills, deps } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        const pricing = vi.spyOn(deps, "pricing");
        state.respond = async () => {
            throw new ApiError(409, "Conflict", "price_changed", "price_changed");
        };
        const { job } = await planAndStart(fills);
        await fills.wait(job.job_id);
        await fills.plan(TARGET);
        expect(pricing).toHaveBeenCalledTimes(2);
    });

    it("stops before sending more rows once the table's own library is excluded", async () => {
        const rows = Array.from({ length: 3 }, (_, i) => itemRow(`r${i}`, { documents: [`u-PDFr${i}`] }));
        const { state, fills, deps } = harness(rows);
        let refused = false;
        deps.writeRefusal = () => (refused ? "table_unavailable" : null);
        state.respond = async (request) => {
            refused = true;
            return answer(request);
        };
        const { job } = await planAndStart(fills);
        const done = await fills.wait(job.job_id);
        expect(state.requests).toHaveLength(1);
        expect(done?.result).toMatchObject({ stopped_by: "unavailable" });
    });

    it("fails the row on 413 as a document too large", async () => {
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        state.respond = async () => {
            throw new ApiError(413, "Payload Too Large", "too_large", "too_large");
        };
        const { job } = await planAndStart(fills);
        await fills.wait(job.job_id);
        expect(state.table.rows[0].failure?.code).toBe("document_too_large");
    });
});

describe("account replacement", () => {
    it("stops the job and writes nothing the old account's requests return", async () => {
        const rows = Array.from({ length: 4 }, (_, i) => itemRow(`r${i}`, { documents: [`u-PDFr${i}`] }));
        const { state, fills, switchAccount } = harness(rows);
        fills.settings.concurrency = 2;
        const gate = deferred<void>();
        state.respond = async (request) => {
            await gate.promise;
            return answer(request);
        };
        const { job } = await planAndStart(fills);
        await until(() => state.requests.length === 2, "two rows in flight");
        switchAccount();
        gate.resolve();
        const done = await fills.wait(job.job_id);
        expect(state.requests).toHaveLength(2);
        expect(state.table.rows.every((row) => !row.cells.method)).toBe(true);
        expect(done?.result).toMatchObject({ stopped_by: "account_changed", not_written: 2 });
    });

    it("refuses to start a plan made for another account", async () => {
        const { fills, switchAccount } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        const planned = await fills.plan(TARGET);
        if (!planned.ok) throw new Error(planned.message);
        switchAccount();
        expect(await fills.start(planned.plan.plan_id)).toMatchObject({ ok: false });
    });
});

describe("an abandoned job", () => {
    it("writes nothing that settles after shutdown, a late read failure included", async () => {
        const { state, fills, deps } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        const gate = deferred<void>();
        deps.readDocument = async () => {
            await gate.promise;
            throw new Error("read failed late");
        };
        await planAndStart(fills);
        await until(() => fills.jobForTable(TARGET)?.in_flight === 1, "the row in flight");
        const commits = state.commits.length;
        await fills.dispose();
        gate.resolve();
        await flush();
        await flush();
        expect(state.commits.length).toBe(commits);
        expect(state.table.rows[0].failure).toBeUndefined();
    });
});

describe("shutdown before dispatch", () => {
    it("sends no request once shutdown began while the body was being prepared", async () => {
        const { state, fills, deps } = harness([itemRow("a", { documents: ["u-PDFa"] })]);
        const fill = deps.fill;
        const gate = deferred<void>();
        let dispatched = false;
        deps.fill = async (body, assertDispatch) => {
            await gate.promise;
            assertDispatch();
            dispatched = true;
            return fill(body, () => {});
        };
        await planAndStart(fills);
        await until(() => fills.jobForTable(TARGET)?.in_flight === 1, "the row in flight");
        const disposing = fills.dispose();
        gate.resolve();
        await disposing;
        await flush();
        expect(dispatched).toBe(false);
        expect(state.requests).toHaveLength(0);
    });
});

describe("shutdown", () => {
    it("flushes the answers received and abandons requests in flight", async () => {
        const rows = Array.from({ length: 3 }, (_, i) => itemRow(`r${i}`, { documents: [`u-PDFr${i}`] }));
        const { state, fills } = harness(rows);
        fills.settings.concurrency = 2;
        const held = deferred<void>();
        state.respond = async (request) => {
            if (request.row_id === "r1") await held.promise;
            return answer(request);
        };
        await planAndStart(fills);
        await until(() => state.requests.length >= 2 && !!state.table.rows[0].documents, "requests out");
        await until(() => state.snapshots.some((s) => s.rows_done >= 1), "the first answer");
        await fills.dispose();
        expect(state.table.rows[0].cells.method).toBeDefined();
        const published = state.snapshots.length;
        held.resolve();
        await flush();
        await flush();
        expect(state.table.rows[1].cells.method).toBeUndefined();
        // Nothing of the abandoned job reaches a plugin that may have reloaded.
        expect(state.snapshots.length).toBe(published);
    });
});

beforeEach(() => {
    vi.clearAllMocks();
});

describe("a chat run's fill_plan and fill", () => {
    const RUN = { runId: "run-1", threadId: "thread-1" };

    function request(op: "fill_plan" | "fill", fields: Record<string, unknown>): ArtifactRequest {
        return { event: "artifact_request", request_id: `${op}-${Math.random()}`, op, ...fields } as ArtifactRequest;
    }

    function context(overrides: Partial<AgentDataRequestContext> = {}): AgentDataRequestContext {
        return { receivedAt: Date.now(), reportPhase: vi.fn(), run: RUN, ...overrides };
    }

    async function plan(fills: InstanceTableFills, fields: Record<string, unknown> = {}) {
        const answer = await fills.agent.plan(request("fill_plan", { key: "u-TABLE001", ...fields }), TARGET);
        if (!answer.ok || !answer.plan) throw new Error(answer.error);
        return answer.plan;
    }

    it("answers a plan without the plugin's local identity, with the columns it answers", async () => {
        const { fills } = harness([itemRow("a"), itemRow("b", { cells: { method: { outcome: "answered", provenance: "model", value: { kind: "text", text: "x" }, documents: ["u-PDFb"] } }, documents: ["u-PDFb"] })]);
        const wire = await plan(fills, { columns: ["method"] });
        expect(wire).toMatchObject({ rows: 1, documents: 1, columns: ["method"], credits: 0.2, prices: { document: 0.2, title_abstract: 0.05 } });
        expect(wire).not.toHaveProperty("table");
        expect(wire).not.toHaveProperty("scope");
    });

    it("answers a refused plan with its code", async () => {
        const { fills } = harness([itemRow("a")]);
        const answer = await fills.agent.plan(request("fill_plan", { key: "u-TABLE001", columns: ["nope"] }), TARGET);
        expect(answer).toMatchObject({ ok: false, error_code: "unknown_column" });
    });

    it("with wait, answers done with the result once the job ends, and starts it as the run's", async () => {
        const { state, fills } = harness([itemRow("a"), itemRow("b")]);
        const wire = await plan(fills);
        const answer = await fills.agent.fill(request("fill", { plan_id: wire.plan_id, tool_call_id: "call-1", wait: true }), context());
        expect(answer).toMatchObject({ ok: true, status: "done", progress: { state: "done", rows_total: 2, rows_done: 2 } });
        expect(answer.result).toMatchObject({ rows_answered: 2, credits_charged: 0.4 });
        expect(state.requests[0].run).toEqual({ run_id: "run-1", thread_id: "thread-1", tool_call_id: "call-1" });
        expect(state.snapshots.at(-1)?.origin).toEqual({ kind: "agent", run: { run_id: "run-1", thread_id: "thread-1", tool_call_id: "call-1" } });
    });

    it("without wait, answers running as soon as the job has started", async () => {
        const { state, fills } = harness([itemRow("a"), itemRow("b")]);
        const held = deferred<void>();
        state.respond = async (r) => {
            await held.promise;
            return answer(r);
        };
        const wire = await plan(fills);
        const answered = await fills.agent.fill(request("fill", { plan_id: wire.plan_id, tool_call_id: "call-1", wait: false }), context());
        expect(answered).toMatchObject({ ok: true, status: "running", progress: { rows_total: 2 } });
        expect(answered.result).toBeUndefined();
        held.resolve();
        await fills.wait(answered.job_id!);
    });

    it("answers running at the safety deadline, counted from the first arrival, and the job goes on", async () => {
        let now = 1_000_000;
        const { state, fills } = harness([itemRow("a")], { agentWaitMs: () => 60_000, now: () => now });
        const held = deferred<void>();
        state.respond = async (r) => {
            await held.promise;
            return answer(r);
        };
        const wire = await plan(fills);
        // The request first arrived 59.99 s ago on this clock: little of the wait is left.
        const answered = await fills.agent.fill(
            request("fill", { plan_id: wire.plan_id, tool_call_id: "call-1", wait: true }),
            context({ receivedAt: now - 59_990 }),
        );
        expect(answered).toMatchObject({ ok: true, status: "running" });
        expect(fills.getJob(answered.job_id!)?.state).toBe("running");
        // A re-sent request after a reattach keeps the first arrival: past the deadline, it answers at once.
        now += 30_000;
        const again = await fills.agent.fill(
            request("fill", { plan_id: wire.plan_id, tool_call_id: "call-1", wait: true }),
            context({ receivedAt: now }),
        );
        expect(again).toMatchObject({ ok: true, status: "running", job_id: answered.job_id });
        held.resolve();
        const done = await fills.wait(answered.job_id!);
        expect(done?.state).toBe("done");
    });

    it("one tool call is one job: a re-sent fill answers from it and never starts another", async () => {
        const { state, fills } = harness([itemRow("a")]);
        const wire = await plan(fills);
        const fill = request("fill", { plan_id: wire.plan_id, tool_call_id: "call-1", wait: true });
        const [first, second] = await Promise.all([fills.agent.fill(fill, context()), fills.agent.fill({ ...fill, request_id: "again" }, context())]);
        expect(first.job_id).toBe(second.job_id);
        expect(first).toMatchObject({ status: "done" });
        expect(second).toMatchObject({ status: "done" });
        expect(state.requests).toHaveLength(1);
        // Even after the job ended.
        const third = await fills.agent.fill({ ...fill, request_id: "later" }, context());
        expect(third).toMatchObject({ ok: true, status: "done", job_id: first.job_id });
    });

    it("answers a refused start with its code, and fill_in_progress with the holder", async () => {
        const { state, fills } = harness([itemRow("a")]);
        const held = deferred<void>();
        state.respond = async (r) => {
            await held.promise;
            return answer(r);
        };
        const first = await plan(fills);
        const second = await plan(fills);
        const running = await fills.agent.fill(request("fill", { plan_id: first.plan_id, tool_call_id: "call-1", wait: false }), context());
        const refused = await fills.agent.fill(request("fill", { plan_id: second.plan_id, tool_call_id: "call-2", wait: true }), context());
        expect(refused).toMatchObject({ ok: false, error_code: "fill_in_progress", job_id: running.job_id });
        const missing = await fills.agent.fill(request("fill", { plan_id: "gone", tool_call_id: "call-3", wait: true }), context());
        expect(missing).toMatchObject({ ok: false, error_code: "plan_not_found" });
        held.resolve();
        await fills.wait(running.job_id!);
    });

    it("never answers pending work naming an excluded library's item, even of a column it does not fill", async () => {
        const answered = { outcome: "answered", provenance: "model", value: { kind: "text", text: "x" }, documents: ["u-PDFa"] } as const;
        // Row a is answered, so a column added since is pending work by name.
        const { state, fills } = harness([itemRow("a", { documents: ["u-PDFa"], cells: { method: answered } }), itemRow("b")]);
        state.table.columns.push({ id: "other", header: "Cited in u-SECRET22", type: "text", description: "?" });
        state.excluded.add("SECRET22");
        const refused = await fills.agent.plan(request("fill_plan", { key: "u-TABLE001", columns: ["method"] }), TARGET);
        expect(refused).toMatchObject({ ok: false, error_code: "table_unavailable" });
        expect(JSON.stringify(refused)).not.toContain("SECRET22");
    });

    it("keeps an excluded library's item out of a finished fill's pending work", async () => {
        const { state, fills } = harness([itemRow("a")]);
        const wire = await plan(fills);
        // A column naming an excluded item is added while the fill runs.
        state.table.columns.push({ id: "other", header: "Cited in u-SECRET22", type: "text", description: "?" });
        state.excluded.add("SECRET22");
        const answered = await fills.agent.fill(request("fill", { plan_id: wire.plan_id, tool_call_id: "call-1", wait: true }), context());
        expect(answered).toMatchObject({ ok: true, status: "done" });
        expect(answered.result?.pending).toBeNull();
        expect(JSON.stringify(answered)).not.toContain("SECRET22");
    });

    it("keeps a failed row id naming an excluded library's item on the device", async () => {
        const { state, fills } = harness([itemRow("a"), itemRow("u-SECRET22")]);
        state.respond = async (r) => (r.row_id === "a" ? answer(r) : { cells: {}, row_failure: { code: "no_answer", message: "No answer." }, charged: 0 });
        const wire = await plan(fills);
        state.excluded.add("SECRET22");
        const answered = await fills.agent.fill(request("fill", { plan_id: wire.plan_id, tool_call_id: "call-1", wait: true }), context());
        expect(answered).toMatchObject({ ok: true, status: "done" });
        expect(JSON.stringify(answered)).not.toContain("SECRET22");
    });

    it("answers a replayed fill from its result after the tab dismissed the job", async () => {
        const { fills } = harness([itemRow("a")]);
        const wire = await plan(fills);
        const fill = request("fill", { plan_id: wire.plan_id, tool_call_id: "call-1", wait: true });
        const first = await fills.agent.fill(fill, context());
        fills.dismiss(first.job_id!);
        expect(fills.getJob(first.job_id!)).toBeNull();
        const replay = await fills.agent.fill({ ...fill, request_id: "replay" }, context());
        expect(replay).toMatchObject({ ok: true, status: "done", job_id: first.job_id, request_id: "replay" });
        expect(replay.result).toEqual(first.result);
    });

    it("answers a replayed background fill from its result after the tab dismissed the job", async () => {
        const { state, fills } = harness([itemRow("a")]);
        const held = deferred<void>();
        state.respond = async (r) => {
            await held.promise;
            return answer(r);
        };
        const wire = await plan(fills);
        const fill = request("fill", { plan_id: wire.plan_id, tool_call_id: "call-1", wait: false });
        const first = await fills.agent.fill(fill, context());
        expect(first).toMatchObject({ ok: true, status: "running" });
        held.resolve();
        await fills.wait(first.job_id!);
        fills.dismiss(first.job_id!);
        expect(fills.getJob(first.job_id!)).toBeNull();
        const replay = await fills.agent.fill({ ...fill, request_id: "replay" }, context());
        expect(replay).toMatchObject({ ok: true, status: "done", job_id: first.job_id, result: { rows_answered: 1 } });
        expect(state.requests).toHaveLength(1);
    });

    it("sends refusals with fixed text, never the service's own message", async () => {
        const { deps, fills } = harness([itemRow("a")]);
        deps.readTable = async () => {
            throw new Error('row "g42-ABCDEFGH" has no cells map');
        };
        const refused = await fills.agent.plan(request("fill_plan", { key: "u-TABLE001" }), TARGET);
        expect(refused).toMatchObject({ ok: false, error_code: "table_unavailable", error: "The table is not available for filling." });
    });

    it("sends no plan of a table whose library was excluded while it was planned", async () => {
        const { deps, fills } = harness([itemRow("a")]);
        const lookup = deps.lookupRows;
        deps.lookupRows = async (rows) => {
            deps.writeRefusal = (target) => (target.key === TARGET.key ? "table_unavailable" : null);
            return lookup(rows);
        };
        // The service's own check ran before the lookup; the handler checks again after.
        const answered = await fills.agent.plan(request("fill_plan", { key: "u-TABLE001" }), TARGET);
        expect(answered).toMatchObject({ ok: false, error_code: "table_unavailable" });
        expect(answered.plan).toBeUndefined();
    });

    it("sends nothing of a table whose library was excluded while it filled", async () => {
        const { deps, fills } = harness([itemRow("a")]);
        const wire = await plan(fills);
        const fill = request("fill", { plan_id: wire.plan_id, tool_call_id: "call-1", wait: true });
        await fills.agent.fill(fill, context());
        deps.writeRefusal = () => "table_unavailable";
        const replay = await fills.agent.fill({ ...fill, request_id: "replay" }, context());
        expect(replay).toMatchObject({ ok: false, error_code: "table_unavailable" });
        expect(replay.result).toBeUndefined();
    });

    it("starts each approved plan even when a model reuses the tool call id", async () => {
        const { state, fills } = harness([itemRow("a"), itemRow("b")]);
        const first = await plan(fills, { rows: ["a"] });
        const one = await fills.agent.fill(request("fill", { plan_id: first.plan_id, tool_call_id: "functions.fill_table:0", wait: true }), context());
        const second = await plan(fills, { rows: ["b"] });
        const two = await fills.agent.fill(
            request("fill", { plan_id: second.plan_id, tool_call_id: "functions.fill_table:0", wait: true }),
            context({ run: { runId: "run-2", threadId: "thread-1" } }),
        );
        expect(two.job_id).not.toBe(one.job_id);
        expect(two).toMatchObject({ ok: true, status: "done", result: { rows_answered: 1 } });
        expect(state.requests.map((r) => r.row_id)).toEqual(["a", "b"]);
    });

    it("answers a refused start shared by two arrivals with each request's own id", async () => {
        const { fills } = harness([itemRow("a")]);
        const fill = request("fill", { plan_id: "gone", tool_call_id: "call-1", wait: true });
        const [first, second] = await Promise.all([
            fills.agent.fill(fill, context()),
            fills.agent.fill({ ...fill, request_id: "again" }, context()),
        ]);
        expect(first).toMatchObject({ ok: false, error_code: "plan_not_found", request_id: fill.request_id });
        expect(second).toMatchObject({ ok: false, error_code: "plan_not_found", request_id: "again" });
    });

    it("never starts a fill whose run was stopped before the job existed", async () => {
        const { state, fills } = harness([itemRow("a")]);
        const wire = await plan(fills);
        const stopped = new AbortController();
        stopped.abort();
        const answered = await fills.agent.fill(request("fill", { plan_id: wire.plan_id, tool_call_id: "call-1", wait: true }), context({ runStopped: stopped.signal }));
        expect(answered).toMatchObject({ ok: false, error_code: "stopped" });
        expect(state.requests).toHaveLength(0);
        expect(fills.listJobs()).toHaveLength(0);
    });

    it("Stop response stops the fill the run waits on; rows in flight finish", async () => {
        const { state, fills } = harness([itemRow("a"), itemRow("b"), itemRow("c")]);
        const held = deferred<void>();
        state.respond = async (r) => {
            await held.promise;
            return answer(r);
        };
        const wire = await plan(fills);
        const stopped = new AbortController();
        const pending = fills.agent.fill(request("fill", { plan_id: wire.plan_id, tool_call_id: "call-1", wait: true }), context({ runStopped: stopped.signal }));
        await until(() => state.requests.length === 1, "the first row in flight");
        stopped.abort();
        held.resolve();
        const answered = await pending;
        expect(answered).toMatchObject({ status: "done" });
        expect(answered.result).toMatchObject({ rows_answered: 1, stopped_by: "stopped", not_started: { stopped: 2 } });
        expect(state.requests).toHaveLength(1);
    });

    it("Stop fill ends the job and a waiting fill answers done with the partial result", async () => {
        const { state, fills } = harness([itemRow("a"), itemRow("b")]);
        const held = deferred<void>();
        state.respond = async (r) => {
            await held.promise;
            return answer(r);
        };
        const wire = await plan(fills);
        const pending = fills.agent.fill(request("fill", { plan_id: wire.plan_id, tool_call_id: "call-1", wait: true }), context());
        await until(() => state.requests.length === 1, "the first row in flight");
        const job = fills.listJobs()[0];
        fills.stop(job.job_id);
        held.resolve();
        const answered = await pending;
        expect(answered).toMatchObject({ status: "done", result: { rows_answered: 1, stopped_by: "stopped" } });
    });
});

