import { describe, expect, it, vi } from "vitest";
import { DocumentWorkQueue } from "../../../src/beaver-extract/DocumentWorkQueue";

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

describe("DocumentWorkQueue", () => {
    it("bounds queued work and admits a successor only after settlement", async () => {
        const queue = new DocumentWorkQueue(1);
        const first = deferred();
        const run = queue.run(() => first.promise);
        const successor = vi.fn(async () => 42);
        const next = queue.run(successor);
        await expect(queue.run(async () => 0)).rejects.toMatchObject({
            name: "WorkerQueueFullError",
        });
        expect(successor).not.toHaveBeenCalled();
        first.resolve();
        await run;
        await expect(next).resolves.toBe(42);
    });
    it("cancels a queued caller without cancelling the active operation", async () => {
        const queue = new DocumentWorkQueue();
        const first = deferred();
        const run = queue.run(() => first.promise);
        const controller = new AbortController();
        const work = vi.fn(async () => 42);
        const cancelled = queue.run(work, controller.signal);
        controller.abort();
        await expect(cancelled).rejects.toMatchObject({
            name: "WorkerAbortError",
        });
        expect(queue.queued).toBe(0);
        const next = queue.run(work);
        expect(work).not.toHaveBeenCalled();
        first.resolve();
        await run;
        await expect(next).resolves.toBe(42);
        expect(work).toHaveBeenCalledTimes(1);
    });
    it("closes admission and rejects queued work while the active operation settles", async () => {
        const queue = new DocumentWorkQueue();
        const first = deferred();
        const run = queue.run(() => first.promise);
        const work = vi.fn(async () => 1);
        const next = queue.run(work);
        queue.close();
        await expect(next).rejects.toMatchObject({ name: "WorkerAbortError" });
        await expect(queue.run(work)).rejects.toMatchObject({
            name: "WorkerAbortError",
        });
        first.resolve();
        await run;
        expect(work).not.toHaveBeenCalled();
    });
});
