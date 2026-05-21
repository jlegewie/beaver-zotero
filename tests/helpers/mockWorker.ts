/**
 * Shared in-process `MockWorker` for MuPDFWorkerClient unit tests.
 *
 * Replaces the real `{ type: "module" }` worker with a synchronous stand-in
 * that records `postMessage` calls and lets the test queue up replies.
 *
 * Configure handshake: a `configure` frame is recorded on `configureMessages`
 * (kept separate from `posted` so op-focused assertions don't have an
 * off-by-one) and immediately acked with a `configured` message so the client
 * releases queued ops. Set `MockWorker.dropNextConfigureAck = true` to swallow
 * the next ack and exercise the worker `ready` recovery path.
 */

import { vi } from "vitest";
import { configurePDFForTests } from "./configurePDFForTests";

export class MockWorker {
    static instances: MockWorker[] = [];
    /** When true, the next `configure` frame is recorded but NOT acked. */
    static dropNextConfigureAck = false;
    onmessage: ((event: { data: any }) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onmessageerror: ((event: any) => void) | null = null;
    posted: Array<{ message: any; transfer: Transferable[] | undefined }> = [];
    configureMessages: any[] = [];
    postMessage = vi.fn((message: any, transfer?: Transferable[]) => {
        if (message?.kind === "configure") {
            this.configureMessages.push(message);
            if (MockWorker.dropNextConfigureAck) {
                MockWorker.dropNextConfigureAck = false;
                return;
            }
            // Ack the configure handshake so the client releases ops.
            this.onmessage?.({ data: { kind: "configured" } });
            return;
        }
        this.posted.push({ message, transfer });
    });
    terminate = vi.fn();

    constructor(public url: string, public options: any) {
        MockWorker.instances.push(this);
    }

    /** Helper: deliver a reply to the most recently posted op message. */
    replyToLast(reply: any): void {
        const last = this.posted[this.posted.length - 1];
        const id = (last?.message as { id: number } | undefined)?.id;
        this.onmessage?.({ data: { id, ...reply } });
    }

    /** Simulate the worker emitting its `ready` lifecycle message. */
    sendReady(): void {
        this.onmessage?.({ data: { kind: "ready" } });
    }

    /** Returns the [message, transfer] tuple for the Nth op message. */
    opCall(n: number): [any, Transferable[] | undefined] {
        const e = this.posted[n];
        return [e?.message, e?.transfer];
    }
}

/**
 * Wire a `Zotero` global whose main window's `Worker` constructor is
 * `MockWorker`, and configure the PDF package against it. Returns the mock
 * window so callers can inspect it.
 */
export function setupZoteroMainWindowWithMockWorker(): any {
    const win: any = { Worker: MockWorker };
    (globalThis as any).Zotero = (globalThis as any).Zotero ?? {};
    // The package no longer reads Zotero.getMainWindow directly — it goes
    // through getConfig().getWorkerHost. The configure-for-tests helper
    // wires both `getWorkerHost` and the singleton slot to this Zotero
    // global so existing assertions (`Zotero.__beaverMuPDFWorkerClient`)
    // continue to inspect the same storage.
    (globalThis as any).Zotero.getMainWindow = vi.fn(() => win);
    (globalThis as any).Zotero.__beaverMuPDFWorkerClient = undefined;
    configurePDFForTests({
        slotHost: (globalThis as any).Zotero,
        slotKey: "__beaverMuPDFWorkerClient",
        getWorkerHost: () => win,
    });
    return win;
}
