import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    isZoteroTransactionTimeout,
    OpenTransactionWatch,
    waitForOpenTransaction,
} from "../../../src/services/openTransaction";

class ZoteroTimeoutError extends Error {}

let open: boolean;
let release: () => void;
let transactionPromise: Promise<void>;
let callbacks: Map<number, () => void>;

function beginTransaction() {
    open = true;
    transactionPromise = new Promise<void>((resolve) => {
        release = resolve;
    });
    for (const callback of callbacks.values()) callback();
}

beforeEach(() => {
    vi.useFakeTimers();
    open = false;
    transactionPromise = Promise.resolve();
    callbacks = new Map();
    let nextId = 0;
    vi.stubGlobal("Zotero", {
        DBConnection: { TimeoutError: ZoteroTimeoutError },
        DB: {
            inTransaction: () => open,
            waitForTransaction: () => (open ? transactionPromise : Promise.resolve()),
            addCallback: (_type: string, callback: () => void) => {
                const id = nextId++;
                callbacks.set(id, callback);
                return id;
            },
            removeCallback: (_type: string, id: number) => callbacks.delete(id),
        },
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("waitForOpenTransaction", () => {
    it("returns at once when no transaction is open", async () => {
        await expect(waitForOpenTransaction(1000)).resolves.toBe(true);
    });

    it("resolves once the open transaction ends", async () => {
        beginTransaction();
        const wait = waitForOpenTransaction(10_000);
        await vi.advanceTimersByTimeAsync(1000);
        open = false;
        release();
        await expect(wait).resolves.toBe(true);
    });

    it("waits for the commit callbacks that run after the commit", async () => {
        // Zotero clears the transaction at commit but settles its promise only
        // after the callbacks, which record its undo entry.
        beginTransaction();
        let resolved = false;
        const wait = waitForOpenTransaction(10_000).then((free) => {
            resolved = true;
            return free;
        });
        await vi.advanceTimersByTimeAsync(500);
        open = false;
        await vi.advanceTimersByTimeAsync(3000);
        expect(resolved).toBe(false);
        release();
        await expect(wait).resolves.toBe(true);
    });

    it("gives up when the commit callbacks outlast the bound", async () => {
        beginTransaction();
        const wait = waitForOpenTransaction(2000);
        await vi.advanceTimersByTimeAsync(500);
        open = false;
        await vi.advanceTimersByTimeAsync(2000);
        await expect(wait).resolves.toBe(false);
    });

    it("waits for a transaction that begins as the first one settles", async () => {
        beginTransaction();
        const firstRelease = release;
        const wait = waitForOpenTransaction(10_000);
        await vi.advanceTimersByTimeAsync(100);
        beginTransaction();
        firstRelease();
        await vi.advanceTimersByTimeAsync(1000);
        open = false;
        release();
        await expect(wait).resolves.toBe(true);
    });

    it("gives up when the transaction outlasts the bound", async () => {
        beginTransaction();
        const wait = waitForOpenTransaction(2000);
        await vi.advanceTimersByTimeAsync(2500);
        await expect(wait).resolves.toBe(false);
    });

    it("does not wait with no time left", async () => {
        beginTransaction();
        await expect(waitForOpenTransaction(0)).resolves.toBe(false);
    });
});

describe("OpenTransactionWatch", () => {
    it("reports how long the open transaction has run", async () => {
        const watch = new OpenTransactionWatch();
        watch.start();
        expect(watch.openAgeMs()).toBe(0);
        beginTransaction();
        await vi.advanceTimersByTimeAsync(4000);
        expect(watch.openAgeMs()).toBe(4000);
        open = false;
        expect(watch.openAgeMs()).toBe(0);
    });

    it("unregisters its callback when stopped", () => {
        const watch = new OpenTransactionWatch();
        watch.start();
        watch.start();
        expect(callbacks.size).toBe(1);
        watch.stop();
        expect(callbacks.size).toBe(0);
        beginTransaction();
        expect(watch.openAgeMs()).toBe(0);
    });
});

it("recognizes Zotero's transaction wait timeout only", () => {
    expect(isZoteroTransactionTimeout(new ZoteroTimeoutError())).toBe(true);
    const own = new Error("Operation timed out after 25 seconds");
    own.name = "TimeoutError";
    expect(isZoteroTransactionTimeout(own)).toBe(false);
});
