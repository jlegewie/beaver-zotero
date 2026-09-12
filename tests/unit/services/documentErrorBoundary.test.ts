import { describe, expect, it, vi } from "vitest";
import {
    ExtractionError,
    ExtractionErrorCode,
    isExtractionError,
} from "@beaver/agent-core/extract/types";
import {
    isWorkerAbortError,
    isTransientWorkerError,
} from "../../../src/beaver-extract/MuPDFWorkerClient";

describe("document errors across independent bundles", () => {
    it("preserves an encrypted-document verdict from another module graph", async () => {
        vi.resetModules();
        const other = await import("@beaver/agent-core/extract/types");
        const error = new other.ExtractionError(
            other.ExtractionErrorCode.ENCRYPTED,
            "Password required",
        );
        expect(error instanceof ExtractionError).toBe(false);
        expect(isExtractionError(error)).toBe(true);
        if (isExtractionError(error))
            expect(error.code).toBe(ExtractionErrorCode.ENCRYPTED);
    });
    it("preserves worker cancellation from another module graph", async () => {
        vi.resetModules();
        const other =
            await import("../../../src/beaver-extract/MuPDFWorkerClient");
        expect(isWorkerAbortError(new other.WorkerAbortError())).toBe(true);
        expect(
            isTransientWorkerError(
                Object.assign(new Error("Queue full"), {
                    name: "WorkerQueueFullError",
                }),
            ),
        ).toBe(true);
        expect(isExtractionError(new Error("Unknown failure"))).toBe(false);
    });
});
