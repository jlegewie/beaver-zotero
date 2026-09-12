export interface ThreadClaim {
    readonly generation: number;
    readonly windowId: string;
    readonly threadId: string;
    readonly token: number;
}
export interface ThreadPresenceSnapshot {
    revision: number;
    claims: ThreadClaim[];
    viewers: Array<{ windowId: string; threadId: string }>;
    history: Record<string, number>;
    deleted: string[];
}

/** Synchronous local admission. Backend admission remains authoritative across devices. */
export class ThreadPresence {
    private generation = 0;
    private sequence = 0;
    private revision = 0;
    private claims = new Map<string, ThreadClaim>();
    private viewers = new Map<string, string>();
    private history = new Map<string, number>();
    private deleted = new Set<string>();
    private listeners = new Set<(snapshot: ThreadPresenceSnapshot) => void>();
    private closed = new Set<string>();

    getSnapshot(): ThreadPresenceSnapshot {
        return {
            revision: this.revision,
            claims: [...this.claims.values()].map((value) => ({ ...value })),
            viewers: [...this.viewers].map(([windowId, threadId]) => ({
                windowId,
                threadId,
            })),
            history: Object.fromEntries(this.history),
            deleted: [...this.deleted],
        };
    }
    subscribe(
        listener: (snapshot: ThreadPresenceSnapshot) => void,
    ): () => void {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => {
            this.listeners.delete(listener);
        };
    }
    private publish(): void {
        this.revision++;
        for (const listener of [...this.listeners]) {
            try {
                listener(this.getSnapshot());
            } catch (error) {
                Zotero.logError(error as Error);
            }
        }
    }
    reset(generation: number): void {
        if (generation === this.generation) return;
        this.generation = generation;
        this.claims.clear();
        this.history.clear();
        this.deleted.clear();
        this.viewers.clear();
        this.publish();
    }
    view(windowId: string, threadId: string | null): void {
        if (this.closed.has(windowId)) return;
        if (threadId === (this.viewers.get(windowId) ?? null)) return;
        if (threadId) this.viewers.set(windowId, threadId);
        else this.viewers.delete(windowId);
        this.publish();
    }
    claim(
        windowId: string,
        threadId: string,
        generation: number,
    ): ThreadClaim | null {
        if (
            generation !== this.generation ||
            this.closed.has(windowId) ||
            this.deleted.has(threadId) ||
            this.claims.has(threadId)
        )
            return null;
        const claim = {
            windowId,
            threadId,
            generation,
            token: ++this.sequence,
        };
        this.claims.set(threadId, claim);
        this.publish();
        return { ...claim };
    }
    owns(claim: ThreadClaim): boolean {
        return (
            claim.generation === this.generation &&
            !this.closed.has(claim.windowId) &&
            this.claims.get(claim.threadId)?.token === claim.token
        );
    }
    /** Bind a provisional chat without ever aliasing another window's draft. */
    bind(claim: ThreadClaim, threadId: string): ThreadClaim | null {
        if (!this.owns(claim) || this.deleted.has(threadId)) return null;
        if (claim.threadId === threadId) return claim;
        if (this.claims.has(threadId)) return null;
        this.claims.delete(claim.threadId);
        const bound = { ...claim, threadId };
        this.claims.set(threadId, bound);
        this.publish();
        return { ...bound };
    }
    release(claim: ThreadClaim): void {
        if (!this.owns(claim)) return;
        this.claims.delete(claim.threadId);
        this.invalidate(claim.threadId);
    }
    invalidate(threadId: string, deleted = false): void {
        if (deleted) {
            this.deleted.add(threadId);
            this.claims.delete(threadId);
        }
        this.history.set(threadId, (this.history.get(threadId) ?? 0) + 1);
        this.publish();
    }
    detach(windowId: string): void {
        this.closed.add(windowId);
        this.viewers.delete(windowId);
        for (const [id, claim] of this.claims) {
            if (claim.windowId !== windowId) continue;
            this.claims.delete(id);
            this.history.set(id, (this.history.get(id) ?? 0) + 1);
        }
        this.publish();
    }
    dispose(): void {
        this.listeners.clear();
        this.claims.clear();
        this.viewers.clear();
        this.history.clear();
        this.deleted.clear();
        this.closed.clear();
    }
}
