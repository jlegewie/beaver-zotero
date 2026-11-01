import { describe, expect, it } from "vitest";
import fixtures from "../../fixtures/artifacts/provider-contract.json";
import { validateArtifactRequest } from "@beaver/agent-core/protocol/artifactProtocol";

describe("artifact request envelopes", () => {
    for (const fixture of fixtures)
        it(`accepts the backend contract: ${fixture.name}`, () => {
            expect(validateArtifactRequest(fixture.request)).toBeNull();
        });
    const read = {
        event: "artifact_request",
        request_id: "read",
        op: "read",
        key: "u-ABCDEFGH",
    };
    it("accepts serialized non-applicable null fields", () => {
        expect(
            validateArtifactRequest({
                ...read,
                keys: null,
                sources: null,
                meta: null,
            }),
        ).toBeNull();
    });
    it.each([
        { ...read, keys: [] },
        { ...read, request_id: " " },
        { ...read, key: "1-ABCDEFGH" },
        { ...read, key: "u-ABCDEF01" },
        { ...read, key: "u-../file" },
        { ...read, op: "list", key: null, keys: ["u-ABCDEFGH", "u-ABCDEFGH"] },
        { ...read, surprise: null },
    ])("rejects malformed envelopes without dispatch", (request) => {
        expect(validateArtifactRequest(request)).toBe("invalid_request");
    });
    it("distinguishes unsupported operations", () => {
        expect(validateArtifactRequest({ ...read, op: "future" })).toBe(
            "unsupported_op",
        );
    });
    it("requires agent provenance on a write", () => {
        const request = {
            ...read,
            op: "apply_edit",
            operations: { title: "New" },
            meta: { actor: "agent", run_id: "run", thread_id: "thread" },
            operation_id: "op",
        };
        expect(validateArtifactRequest(request)).toBeNull();
        expect(
            validateArtifactRequest({ ...request, meta: { actor: "agent" } }),
        ).toBe("invalid_request");
        expect(validateArtifactRequest({ ...request, operation_id: " " })).toBe("invalid_request");
        expect(validateArtifactRequest({ ...request, operations: [] })).toBe("invalid_request");
    });
    it("no longer knows a whole-spec write", () => {
        expect(validateArtifactRequest({ ...read, op: "write" })).toBe("unsupported_op");
    });
    it("takes sources with unique ids on a preview, and column drafts", () => {
        const preview = { event: "artifact_request", request_id: "p", op: "preview", sources: [{ id: "s1", type: "items", ids: ["u-ABCDEFGH"] }] };
        expect(validateArtifactRequest(preview)).toBeNull();
        expect(validateArtifactRequest({ ...preview, columns: [{ header: "N", type: "text" }] })).toBeNull();
        expect(validateArtifactRequest({ ...preview, columns: ["n"] })).toBe("invalid_request");
        expect(validateArtifactRequest({ ...preview, sources: [] })).toBe("invalid_request");
        expect(validateArtifactRequest({ ...preview, sources: [{ id: "s1", type: "items" }, { id: "s1", type: "library" }] })).toBe("invalid_request");
        expect(validateArtifactRequest({ ...preview, key: "u-ABCDEFGH" })).toBe("invalid_request");
    });
});

describe("create into a collection", () => {
    const create = {
        event: "artifact_request",
        request_id: "create",
        op: "create",
        kind: "table",
        library_ref: "u",
        title: "Comparison",
        sources: [{ id: "s1", type: "items", ids: ["u-ABCDEFGH"] }],
        meta: { actor: "agent", run_id: "run", thread_id: "thread" },
        operation_id: "op",
    };
    it("accepts a bare collection key on create only", () => {
        expect(validateArtifactRequest({ ...create, collection_key: "CASHTRN2" })).toBeNull();
        expect(validateArtifactRequest({ ...create, collection_key: null })).toBeNull();
        expect(
            validateArtifactRequest({ event: "artifact_request", request_id: "r", op: "read", key: "u-ABCDEFGH", collection_key: "CASHTRN2" }),
        ).toBe("invalid_request");
    });
    it.each(["u-CASHTRN2", "cashtrn2", "CASHTRN0", 7])("rejects a malformed key %s", (key) => {
        expect(validateArtifactRequest({ ...create, collection_key: key })).toBe("invalid_request");
    });
});
