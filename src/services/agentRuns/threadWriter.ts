/**
 * The session's lease on writing to a chat: its presence claim on the thread,
 * held while it prepares a message, runs, and settles. The claim is the
 * session's own (`session:<id>`), not a window's: it outlives the windows that
 * view the session and ends with the session. Hosts without the Zotero
 * instance's presence registry do not take part.
 */

import type { ThreadClaim } from "../threads/threadPresence";
import type { RunSession } from "./runSession";

export interface WriterLease {
    claim: ThreadClaim;
    preparing: number;
    /** The admission read in flight for this lease; resolves to whether writes may proceed. */
    admission?: Promise<boolean>;
}

/** Who the presence claims of session `sessionId` are held by: the session itself. */
export function claimHolderOf(sessionId: string): string {
    return `session:${sessionId}`;
}

/** Who a session's presence claims are held by. */
export function sessionClaimHolder(session: RunSession): string {
    return claimHolderOf(session.id);
}

export function currentWriter(session: RunSession): WriterLease | undefined {
    return session.writerLease;
}

export function ownsWriter(session: RunSession, value: WriterLease | undefined): boolean {
    if (!value) return !Zotero.Beaver?.presence;
    return (
        session.writerLease === value &&
        !session.ended &&
        Zotero.Beaver.presence.owns(value.claim)
    );
}

export function acquireWriter(
    session: RunSession,
    threadId: string | null,
    generation: number,
): WriterLease | null | undefined {
    // Pure atom tests and hosts without the Zotero instance do not participate.
    if (!Zotero.Beaver?.presence) return undefined;
    if (session.ended) return null;
    const lease = session.writerLease;
    if (
        lease &&
        ownsWriter(session, lease) &&
        (!threadId || lease.claim.threadId === threadId)
    )
        return lease;
    const holder = sessionClaimHolder(session);
    const claim = Zotero.Beaver.presence.claim(
        holder,
        threadId ?? `draft:${session.id}:${++session.draftSeq}`,
        generation,
        holder,
    );
    if (!claim) return null;
    session.writerLease = { claim, preparing: 0 };
    session.writerSeq++;
    session.lifecycleListener?.();
    return session.writerLease;
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

export function releaseWriter(session: RunSession, value = session.writerLease): void {
    if (!value || value !== session.writerLease) return;
    session.writerLease = undefined; // Revoke callbacks before notifying viewers.
    Zotero.Beaver.presence.release(value.claim);
    Zotero.Beaver.threads.invalidateViews();
    session.lifecycleListener?.();
}

export function assertWriter(session: RunSession, value: WriterLease | undefined): void {
    if (!ownsWriter(session, value))
        throw Object.assign(new Error("Chat operation is no longer current"), {
            code: "thread_operation_canceled",
        });
}
