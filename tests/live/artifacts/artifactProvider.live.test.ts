import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    isZoteroAvailable,
    skipIfNoZotero,
} from "../../helpers/zoteroAvailability";
import { post } from "../../helpers/zoteroHttpClient";

let available = false;
let key: string;
let created: any;
let written: any;
let writeRequest: any;
const operationId = `provider-live-${Date.now()}`;
const spec = {
    id: operationId,
    title: "Provider acceptance table",
    columns: [
        {
            id: "answer",
            header: "Answer",
            type: "text",
            description: "What is reported?",
        },
    ],
    rows: [{ id: "paper", cells: {} }],
};
const call = (op: string, fields: Record<string, unknown> = {}) =>
    post<any>("/beaver/artifact", {
        event: "artifact_request",
        request_id: `${operationId}-${op}-${Date.now()}`,
        op,
        ...(key ? { key } : {}),
        ...fields,
    });

beforeAll(async () => {
    available = await isZoteroAvailable();
});
afterAll(async () => {
    if (available && key) await call("delete");
});

describe("portable artifact provider in Zotero", () => {
    it("creates an operation-backed persistent document", async (ctx) => {
        skipIfNoZotero(ctx, available);
        created = await call("create", {
            kind: "table",
            library_ref: "u",
            title: spec.title,
            spec,
            meta: { actor: "user" },
            operation_id: operationId,
        });
        expect(created).toMatchObject({
            ok: true,
            saved: true,
            version: 1,
            operation: { operation_id: operationId },
        });
        key = `${created.zotero_item.library_ref}-${created.zotero_item.zotero_key}`;
        expect(created.spec.key).toBe(created.zotero_item.zotero_key);
    });
    it("reads fresh state and commits a completed not-reported result", async (ctx) => {
        skipIfNoZotero(ctx, available);
        const read = await call("read");
        expect(read).toMatchObject({
            ok: true,
            version: 1,
            sha256: created.sha256,
        });
        writeRequest = {
            spec: {
                ...read.spec,
                rows: [
                    {
                        id: "paper",
                        cells: {
                            answer: {
                                outcome: "not_reported",
                                provenance: "extracted",
                                details: {
                                    kind: "text",
                                    text: "The material supplies no answer.",
                                },
                            },
                        },
                    },
                ],
            },
            meta: {
                actor: "agent",
                run_id: operationId,
                thread_id: operationId,
            },
            expected_version: read.version,
            expected_sha256: read.sha256,
            operation_id: `${operationId}-write`,
        };
        written = await call("write", writeRequest);
        expect(written).toMatchObject({
            ok: true,
            saved: true,
            summary: {
                columns_detail: {
                    answer: { filled: 0, completed: 1, not_reported: 1 },
                },
            },
        });
    });
    it("edits locally, retains user ownership of a blank, and replays without overwriting it", async (ctx) => {
        skipIfNoZotero(ctx, available);
        const edited = await post<any>("/beaver/test/table-edit", {
            library_id: created.zotero_item.library_id,
            key: created.spec.key,
            mutations: [
                {
                    op: "set_cells",
                    cells: [
                        {
                            row: "paper",
                            column: "answer",
                            cell: { provenance: "user" },
                        },
                    ],
                },
            ],
            actor: "user",
        });
        expect(edited.ok).toBe(true);
        const replay = await call("write", writeRequest);
        expect(replay).toMatchObject({
            ok: true,
            replayed: true,
            operation: written.operation,
        });
        expect(replay.spec.rows[0].cells.answer).toEqual({
            provenance: "user",
        });
        const conflict = await call("write", {
            ...writeRequest,
            operation_id: `${operationId}-conflict`,
        });
        expect(conflict).toMatchObject({
            ok: false,
            conflict: true,
            error_code: "conflict",
            version: replay.version,
            sha256: replay.sha256,
        });
    });
    it("restores retained content as a new revision and lists explicit available/unavailable identities", async (ctx) => {
        skipIfNoZotero(ctx, available);
        const versions = await call("versions");
        expect(versions.versions.length).toBeGreaterThanOrEqual(3);
        const restored = await call("revert", {
            to_version: written.version,
            meta: { actor: "user" },
        });
        expect(restored.ok).toBe(true);
        expect(restored.version).toBeGreaterThan(written.version);
        expect(restored.spec.rows[0].cells.answer.outcome).toBe("not_reported");
        const list = await call("list", {
            key: null,
            keys: [key, "u-ZZZZZZZZ"],
            thread_id: "unseen-thread",
        });
        expect(list.items[0]).toMatchObject({
            key,
            unavailable: false,
            version: restored.version,
        });
        expect(list.items[1]).toEqual({
            key: "u-ZZZZZZZZ",
            kind: "table",
            unavailable: true,
            error_code: "not_found",
            unseen: [],
        });
    });
    it("maps invalid envelopes and mutation identity mismatch without another commit", async (ctx) => {
        skipIfNoZotero(ctx, available);
        expect(await call("read", { spec: {} })).toMatchObject({
            ok: false,
            error_code: "invalid_request",
        });
        expect(await call("unknown")).toMatchObject({
            ok: false,
            error_code: "unsupported_op",
        });
        expect(
            await call("write", {
                ...writeRequest,
                spec: { ...writeRequest.spec, title: "Different payload" },
            }),
        ).toMatchObject({ ok: false, error_code: "operation_mismatch" });
    });
});
