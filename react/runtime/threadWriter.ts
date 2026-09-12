import type { ThreadClaim } from "../../src/services/threads/threadPresence";
import { tryGetWindowRuntime } from "./windowRuntime";

export interface WriterLease {
    claim: ThreadClaim;
    preparing: number;
}
let lease: WriterLease | undefined;
let draftSeq = 0;
export function currentWriter(): WriterLease | undefined {
    return lease;
}
export function ownsWriter(value: WriterLease | undefined): boolean {
    if (!value) return !Zotero.Beaver?.presence;
    return (
        lease === value &&
        !!tryGetWindowRuntime() &&
        Zotero.Beaver.presence.owns(value.claim)
    );
}
export function acquireWriter(
    threadId: string | null,
    generation: number,
): WriterLease | null | undefined {
    // Pure atom tests and hosts without the Zotero instance do not participate.
    if (!Zotero.Beaver?.presence) return undefined;
    const runtime = tryGetWindowRuntime();
    if (!runtime) return null;
    if (
        lease &&
        ownsWriter(lease) &&
        (!threadId || lease.claim.threadId === threadId)
    )
        return lease;
    const claim = Zotero.Beaver.presence.claim(
        runtime.id,
        threadId ?? `draft:${runtime.id}:${++draftSeq}`,
        generation,
    );
    if (!claim) return null;
    lease = { claim, preparing: 0 };
    return lease;
}
export function bindWriter(
    value: WriterLease | undefined,
    threadId: string,
): boolean {
    if (!value) return !Zotero.Beaver?.presence;
    const bound = Zotero.Beaver.presence.bind(value.claim, threadId);
    if (!bound) return false;
    value.claim = bound;
    return true;
}
export function releaseWriter(value = lease): void {
    if (!value || value !== lease) return;
    lease = undefined; // Revoke callbacks before notifying viewers.
    Zotero.Beaver.presence.release(value.claim);
    Zotero.Beaver.threads.invalidateViews();
}
export function assertWriter(value: WriterLease | undefined): void {
    if (!ownsWriter(value))
        throw Object.assign(new Error("Chat operation is no longer current"), {
            code: "thread_operation_canceled",
        });
}
