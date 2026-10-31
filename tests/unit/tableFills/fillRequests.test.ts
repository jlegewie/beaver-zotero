/**
 * The fill endpoint's shapes, against the backend's `table-fill-requests`
 * cases: the plugin hashes each question as the backend does, splices the
 * document into the body without changing it, and writes each response's
 * cells through `set_cells`. Also how a failed request is classified.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { questionHash, type Column, type TableSpec } from "@beaver/agent-core/layouts/table";
import { applyMutations } from "@beaver/agent-core/layouts/tableMutations";
import type { TableFillRequest, TableFillResponse } from "@beaver/agent-core/protocol/tableFillProtocol";
import {
    ApiError,
    RequestTimeoutError,
    ServerError,
    SessionExpiredError,
    SessionRefreshError,
} from "@beaver/agent-core/types/apiErrors";
import { classifyFillError, fillRequestBody } from "../../../src/services/tableFills/tableFillApi";

interface FillRequestFixture {
    name: string;
    request: TableFillRequest;
    response: TableFillResponse;
}

const dir = fileURLToPath(new URL("../../fixtures/artifacts/table-fill-requests/", import.meta.url));
const fixtures = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ file, fixture: JSON.parse(readFileSync(path.join(dir, file), "utf8")) as FillRequestFixture }));

function columnsOf(request: TableFillRequest): Column[] {
    return request.columns.map((column) => ({
        id: column.id,
        header: column.header,
        type: column.type as Column["type"],
        ...(column.description ? { description: column.description } : {}),
        ...(column.options ? { options: column.options } : {}),
    }));
}

describe("the table-fill-requests fixture corpus", () => {
    it("is not empty", () => expect(fixtures.length).toBeGreaterThan(0));

    for (const { file, fixture } of fixtures) {
        describe(`${file}: ${fixture.name}`, () => {
            const { request, response } = fixture;

            it("hashes every question as the backend does", () => {
                for (const [index, column] of columnsOf(request).entries())
                    expect(questionHash(column)).toBe(request.columns[index].question_hash);
            });

            it("splices the document into the body unchanged", () => {
                const { document, ...envelope } = request;
                const body = fillRequestBody(
                    envelope,
                    document ? { id: document.id, kind: document.kind, json: JSON.stringify(document.content) } : undefined,
                );
                expect(JSON.parse(body)).toEqual(request);
            });

            it("writes the response's cells through set_cells", () => {
                const documents = request.document ? [request.document.id] : [];
                const spec: TableSpec = {
                    id: "t",
                    columns: columnsOf(request),
                    rows: [{ id: request.row_id, cells: {}, ...(documents.length ? { documents } : {}) }],
                };
                const result = applyMutations(
                    spec,
                    [
                        {
                            op: "set_cells",
                            cells: Object.entries(response.cells).map(([column, cell]) => ({
                                row: request.row_id,
                                column,
                                cell,
                                question_hash: request.columns.find((c) => c.id === column)!.question_hash,
                                revision: 0,
                                expected_documents: documents,
                            })),
                        },
                        {
                            op: "update_row",
                            row: request.row_id,
                            failure: response.row_failure ?? null,
                            expected_documents: documents,
                        },
                    ],
                    { skipMissing: true },
                );
                if (!result.ok) throw new Error(result.error.message);
                expect(result.skipped).toEqual([]);
                expect(Object.keys(result.spec.rows[0].cells).sort()).toEqual(Object.keys(response.cells).sort());
                if (response.row_failure) expect(result.spec.rows[0].failure).toEqual(response.row_failure);
            });
        });
    }
});

describe("fillRequestBody", () => {
    it("serializes the envelope alone when there is no document", () => {
        const body = fillRequestBody({
            job_id: "j",
            row_id: "r",
            price: 0.05,
            table: { title: "T" },
            columns: [],
            row: { reference: {}, abstract: "A" },
        });
        expect(JSON.parse(body)).toEqual({ job_id: "j", row_id: "r", price: 0.05, table: { title: "T" }, columns: [], row: { reference: {}, abstract: "A" } });
    });
});

describe("classifyFillError", () => {
    it("retries what never reached the server or was turned away for now", () => {
        expect(classifyFillError(new SessionRefreshError("down", 0, "Network Error"))).toMatchObject({ kind: "retry", code: "network" });
        expect(classifyFillError(new RequestTimeoutError("slow"))).toMatchObject({ kind: "retry", code: "network" });
        expect(classifyFillError(new TypeError("fetch failed"))).toMatchObject({ kind: "retry" });
        expect(classifyFillError(new ApiError(429, "Too Many", "x", "rate_limited", { code: "rate_limited", retry_after_seconds: 5 }))).toEqual({
            kind: "retry",
            code: "rate_limited",
            retryAfterMs: 5000,
        });
        expect(classifyFillError(new ApiError(503, "Unavailable", "x", "unavailable"))).toMatchObject({ kind: "retry", code: "unavailable" });
        expect(classifyFillError(new ServerError("Server error: 502"))).toMatchObject({ kind: "retry" });
    });

    it("stops the job on 402, price_changed and a lost session", () => {
        expect(classifyFillError(new ApiError(402, "Payment Required", "x", "insufficient_credits"))).toEqual({ kind: "stop", code: "insufficient_credits" });
        expect(classifyFillError(new ApiError(409, "Conflict", "x", "price_changed"))).toEqual({ kind: "stop", code: "price_changed" });
        expect(classifyFillError(new SessionExpiredError("gone"))).toEqual({ kind: "stop", code: "signed_out" });
    });

    it("fails the row on 413 and 400", () => {
        expect(classifyFillError(new ApiError(413, "Too Large", "x", "too_large"))).toMatchObject({ kind: "row", code: "too_large" });
        expect(classifyFillError(new ApiError(400, "Bad Request", "x", "invalid_request"))).toMatchObject({ kind: "row", code: "invalid_request" });
    });
});
