import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadPresence } from "../../../src/services/threads/threadPresence";

let presence: ThreadPresence;
beforeEach(() => {
    presence = new ThreadPresence();
    presence.reset(3);
});
describe("instance thread admission", () => {
    it("admits exactly one simultaneous writer while keeping both viewers", async () => {
        presence.view("a", "thread");
        presence.view("b", "thread");
        const claims = await Promise.all(
            ["a", "b"].map((id) =>
                Promise.resolve().then(() => presence.claim(id, "thread", 3)),
            ),
        );
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(presence.getSnapshot().viewers).toHaveLength(2);
        for (const phase of [
            "prepare",
            "connect",
            "approval",
            "question",
            "credit",
            "batch",
            "continuation",
            "finalization",
        ]) {
            expect(presence.claim("b", "thread", 3), phase).toBeNull();
        }
    });
    it("records a session's claim as the session's, acting for its window", () => {
        const claim = presence.claim("window-a", "t", 3, "session:s1")!;
        expect(presence.getSnapshot().claims).toEqual([expect.objectContaining({ ownerId: "session:s1", windowId: "window-a" })]);
        // The claim acts for its window: it ends when that window closes.
        presence.detach("window-a");
        expect(presence.owns(claim)).toBe(false);
        expect(presence.claim("window-b", "t", 3)?.ownerId).toBe("window-b");
    });
    it("never lets a stale completion release a successor", () => {
        const first = presence.claim("a", "t", 3)!;
        presence.release(first);
        const next = presence.claim("b", "t", 3)!;
        presence.release(first);
        expect(presence.owns(next)).toBe(true);
        expect(presence.getSnapshot().history.t).toBe(1);
    });
    it("binds distinct provisional drafts and refuses a colliding server identity", () => {
        const a = presence.claim("a", "draft:a", 3)!;
        const b = presence.claim("b", "draft:b", 3)!;
        const bound = presence.bind(a, "t")!;
        expect(presence.bind(b, "t")).toBeNull();
        expect(presence.owns(bound)).toBe(true);
        expect(presence.owns(b)).toBe(true);
    });
    it("revokes closing and deleted owners before publishing; reset rejects prior accounts", () => {
        const claim = presence.claim("a", "t", 3)!;
        const observations: boolean[] = [];
        presence.subscribe(() => observations.push(presence.owns(claim)));
        presence.detach("a");
        expect(observations.at(-1)).toBe(false);
        expect(presence.claim("a", "other", 3)).toBeNull();
        const next = presence.claim("b", "t", 3)!;
        presence.invalidate("t", true);
        expect(presence.owns(next)).toBe(false);
        expect(presence.claim("b", "t", 3)).toBeNull();
        presence.reset(4);
        expect(presence.claim("b", "t", 3)).toBeNull();
        expect(presence.claim("b", "t", 4)).not.toBeNull();
    });
    it("isolates independent renderer modules and atom identities against one instance", async () => {
        (Zotero as any).Beaver = {
            presence,
            threads: { invalidateViews: vi.fn() },
        };
        const session = (id: string) => ({ id, writerLease: undefined, ended: false }) as any;
        vi.resetModules();
        const firstAtoms = await import("@beaver/agent-core/run-state/atoms");
        vi.resetModules();
        const secondAtoms = await import("@beaver/agent-core/run-state/atoms");
        expect(firstAtoms.currentThreadIdAtom).not.toBe(
            secondAtoms.currentThreadIdAtom,
        );
        // Each session holds its own lease, through one module.
        const writer = await import("../../../src/services/agentRuns/threadWriter");
        const a = session("a");
        const b = session("b");
        const lease = writer.acquireWriter(a, "t", 3)!;
        expect(writer.acquireWriter(b, "t", 3)).toBeNull();
        expect(writer.currentWriter(b)).toBeUndefined();
        writer.releaseWriter(a, lease);
        const successor = writer.acquireWriter(b, "t", 3)!;
        writer.releaseWriter(a, lease);
        expect(writer.ownsWriter(b, successor)).toBe(true);
        // A session's claim ends with the session, not with a window.
        presence.detach("b");
        expect(writer.ownsWriter(b, successor)).toBe(true);
        presence.detach("session:b");
        expect(writer.ownsWriter(b, successor)).toBe(false);
    });
});
