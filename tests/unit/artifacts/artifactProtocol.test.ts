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
                spec: null,
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
    it("requires agent provenance and exact positive revision guards", () => {
        const request = {
            ...read,
            op: "write",
            spec: {},
            meta: { actor: "agent", run_id: "run", thread_id: "thread" },
            expected_version: 1,
            expected_sha256: "a".repeat(64),
            operation_id: "op",
        };
        expect(validateArtifactRequest(request)).toBeNull();
        expect(
            validateArtifactRequest({ ...request, meta: { actor: "agent" } }),
        ).toBe("invalid_request");
        expect(
            validateArtifactRequest({ ...request, expected_version: 1.5 }),
        ).toBe("invalid_request");
        expect(
            validateArtifactRequest({ ...request, expected_sha256: "abc" }),
        ).toBe("invalid_request");
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
        spec: {},
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
