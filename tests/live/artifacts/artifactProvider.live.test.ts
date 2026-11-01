import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    isZoteroAvailable,
    skipIfNoZotero,
} from "../../helpers/zoteroAvailability";
import { post } from "../../helpers/zoteroHttpClient";
import {
    getExcludedLibraries,
    setExcludedLibraries,
    restoreExcludedLibraries,
} from "../../helpers/cacheInspector";

const libraryRef = process.env.BEAVER_TEST_TABLE_LIBRARY_REF || "u";
let available = false;
let key: string;
let papers: string[] = [];
let created: any;
let createRequest: any;
let edited: any;
const operationId = `provider-live-${Date.now()}`;
const meta = { actor: "agent", run_id: operationId, thread_id: operationId, change: "Edited table" };
let sequence = 0;
/** A provider request that names no table. */
const send = (op: string, fields: Record<string, unknown> = {}) =>
    post<any>("/beaver/artifact", {
        event: "artifact_request",
        request_id: `${operationId}-${op}-${++sequence}`,
        op,
        ...fields,
    });
/** A provider request for the table under test. */
const call = (op: string, fields: Record<string, unknown> = {}) => send(op, { ...(key ? { key } : {}), ...fields });
const at = () => ({ libraryID: created.zotero_item.library_id, key: created.zotero_item.zotero_key });
const editRequest = (operations: Record<string, unknown>, operation_id: string) =>
    call("apply_edit", { operations, meta, operation_id });

/** Two regular items of the test library, as portable ids. */
async function twoPapers(): Promise<string[]> {
    const libraries = await post<any>("/beaver/library/libraries", {});
    const library = (libraries.libraries ?? []).find((l: any) => l.library_ref === libraryRef);
    if (!library) return [];
    const listed = await post<any>("/beaver/library/list", { library_id: library.library_id, limit: 2 });
    return (listed.items ?? []).map((item: any) => item.item_id);
}

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (available) papers = await twoPapers();
});
afterAll(async () => {
    if (available && key) await call("delete");
});

describe("portable artifact provider in Zotero", () => {
    it("previews a proposal's sources without writing anything", async (ctx) => {
        skipIfNoZotero(ctx, available);
        expect(papers).toHaveLength(2);
        const preview = await send("preview", {
            sources: [{ id: "s1", type: "items", ids: [papers[0], papers[1], papers[0]] }],
        });
        expect(preview).toMatchObject({
            ok: true,
            preview: { rows: 2, sources: [{ entry: { id: "s1", ids: papers }, count: 2 }] },
        });
        expect(preview).not.toHaveProperty("zotero_item");
    });
    it("creates a table from its sources and columns, once per operation", async (ctx) => {
        skipIfNoZotero(ctx, available);
        createRequest = {
            kind: "table",
            library_ref: libraryRef,
            title: "Provider acceptance table",
            sources: [{ id: "s1", type: "items", ids: papers }],
            columns: [
                { header: "Answer", type: "text", description: "What is reported?" },
                {
                    header: "Design",
                    type: "select",
                    description: "What is the design?",
                    options: [{ label: "Trial" }, { label: "Survey" }],
                },
            ],
            meta: { actor: "user" },
            operation_id: operationId,
        };
        created = await send("create", createRequest);
        expect(created).toMatchObject({
            ok: true,
            saved: true,
            version: 1,
            replayed: false,
            pending: { rows: 2 },
        });
        expect(created).not.toHaveProperty("operation");
        key = `${created.zotero_item.library_ref}-${created.zotero_item.zotero_key}`;
        expect(created.zotero_item.library_ref).toBe(libraryRef);
        expect(created.spec.key).toBe(created.zotero_item.zotero_key);
        expect(created.spec.rows).toHaveLength(2);

        const replay = await send("create", createRequest);
        expect(replay).toMatchObject({ ok: true, replayed: true, zotero_item: created.zotero_item, version: 1 });
        const mismatch = await send("create", { ...createRequest, title: "Different payload" });
        expect(mismatch).toMatchObject({ ok: false, error_code: "operation_mismatch" });
    });
    it("applies an edit as one sealed version, replays it, and refuses its id reused", async (ctx) => {
        skipIfNoZotero(ctx, available);
        // The user corrects one design answer.
        const row = created.spec.rows[0].id;
        expect(
            await post<any>("/beaver/test/table-edit", {
                ...at(),
                mutations: [
                    {
                        op: "set_cells",
                        cells: [{ row, column: "design", cell: { outcome: "answered", provenance: "user", value: { kind: "select", label: "Survey" } } }],
                    },
                ],
                actor: "user",
            }),
        ).toMatchObject({ ok: true });
        const operations = {
            title: "Provider acceptance table (edited)",
            add_columns: [{ header: "Country", type: "text", description: "Where was it done?" }],
            update_columns: [{ id: "design", options: [{ label: "Trial" }] }],
        };
        edited = await editRequest(operations, `${operationId}-edit`);
        expect(edited).toMatchObject({
            ok: true,
            replayed: false,
            version: 3,
            changes: [
                { op: "title" },
                // Removing the option the user chose clears it and says so.
                { op: "update_column", column: "design", fields: ["options"], cleared: 1, user_cleared: 1 },
                { op: "add_column", column: "country" },
            ],
            pending: { rows: 2 },
        });
        const versions = await post<any>("/beaver/test/table-versions", at());
        expect(versions.versions.at(-1)).toMatchObject({ version: 3, sealed: true });

        const replay = await editRequest(operations, `${operationId}-edit`);
        expect(replay).toMatchObject({ ok: true, replayed: true, version: 3, changes: edited.changes });
        expect(await editRequest({ title: "Another title" }, `${operationId}-edit`)).toMatchObject({
            ok: false,
            error_code: "operation_mismatch",
        });
        const refused = await editRequest({ title: "Never", remove_columns: ["answer", "gone"] }, `${operationId}-bad`);
        expect(refused).toMatchObject({ ok: false, error_code: "unknown_column" });
        expect(refused.error).toContain("remove_columns[1]");
        expect((await call("read")).version).toBe(3);
    });
    it("removes a row and remembers its paper, restoring it when added back", async (ctx) => {
        skipIfNoZotero(ctx, available);
        const row = edited.spec.rows[1].id;
        const removed = await editRequest({ remove_rows: [row] }, `${operationId}-remove`);
        expect(removed).toMatchObject({ ok: true, changes: [{ op: "remove_rows", rows: 1 }] });
        expect(removed.spec.removed).toHaveLength(1);
        const restored = await editRequest(
            { add_sources: [{ type: "items", ids: [papers[1]] }] },
            `${operationId}-restore`,
        );
        expect(restored).toMatchObject({
            ok: true,
            changes: [{ op: "add_source", rows_added: 0, rows_restored: 1 }],
        });
        expect(restored.spec.rows).toHaveLength(2);
    });
    it("restores a version as a new one and lists available and unavailable tables", async (ctx) => {
        skipIfNoZotero(ctx, available);
        const versions = await call("versions");
        expect(versions.versions.length).toBeGreaterThanOrEqual(5);
        // The replay record stays on the device.
        expect(versions.versions.at(-1)).not.toHaveProperty("changes");
        expect(versions.versions.at(-1)).not.toHaveProperty("operation_id");
        const restored = await call("revert", { to_version: 1, meta: { actor: "user" } });
        expect(restored.ok).toBe(true);
        expect(restored.version).toBeGreaterThan(edited.version);
        expect(restored.spec.title).toBe("Provider acceptance table");
        const list = await call("list", {
            key: null,
            keys: [key, "u-ZZZZZZZZ"],
            thread_id: "unseen-thread",
        });
        expect(list.items[0]).toMatchObject({ key, unavailable: false, version: restored.version });
        expect(list.items[1]).toEqual({
            key: "u-ZZZZZZZZ",
            kind: "table",
            unavailable: true,
            error_code: "not_found",
            unseen: [],
        });
    });
    it("refuses invalid envelopes and the whole-spec write", async (ctx) => {
        skipIfNoZotero(ctx, available);
        expect(await call("read", { spec: {} })).toMatchObject({ ok: false, error_code: "invalid_request" });
        expect(await call("unknown")).toMatchObject({ ok: false, error_code: "unsupported_op" });
        expect(
            await call("write", { spec: created.spec, meta, operation_id: `${operationId}-write` }),
        ).toMatchObject({ ok: false, error_code: "unsupported_op" });
    });
    it("retains displaced work after a simulated sync conflict and restores its shadow", async (ctx) => {
        skipIfNoZotero(ctx, available);
        const before = await call("read");
        expect(
            await post("/beaver/test/table-corrupt", { ...at(), mode: "sync_conflict", toVersion: 1 }),
        ).toMatchObject({ ok: true });
        const opened = await post<any>("/beaver/test/table-open", at());
        expect(opened.conflict).toMatchObject({ kind: "sync_conflict", restorable: true });
        expect(await post("/beaver/test/table-restore-shadow", { ...at(), actor: "user" })).toMatchObject({ ok: true });
        const restored = await call("read");
        expect(restored.spec.rows).toEqual(before.spec.rows);
        expect(await post("/beaver/test/table-read", at())).toMatchObject({ ok: true, sync_state: 0 });
    });
    it("refuses excluded tables and sources while preserving local snapshot opening", async (ctx) => {
        skipIfNoZotero(ctx, available);
        const original = await getExcludedLibraries();
        try {
            expect(await setExcludedLibraries([created.zotero_item.library_id])).toMatchObject({ ok: true });
            const refused = await call("read");
            expect(refused).toMatchObject({ ok: false, error_code: "library_excluded" });
            expect(refused).not.toHaveProperty("spec");
            expect(await editRequest({ title: "Never" }, `${operationId}-excluded`)).toMatchObject({
                ok: false,
                error_code: "library_excluded",
            });
            const preview = await send("preview", { sources: [{ id: "s1", type: "items", ids: [papers[0]] }] });
            expect(preview.ok).toBe(true);
            expect(preview.preview.rows).toBe(0);
            expect(JSON.stringify(preview)).not.toContain(created.spec.rows[0].cells._reference.value.title);
            const listed = await call("list", { key: null, keys: [key] });
            expect(listed.items[0]).toMatchObject({ unavailable: true, error_code: "library_excluded" });
            expect(listed.items[0]).not.toHaveProperty("title");
            expect(await post("/beaver/test/open-stored-table", at())).toMatchObject({ ok: true });
        } finally {
            await restoreExcludedLibraries(original.excluded_libraries);
        }
    });
});
