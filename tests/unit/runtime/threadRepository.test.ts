import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
    getPaginatedThreads: vi.fn(),
    renameThread: vi.fn(),
    deleteThread: vi.fn(),
    starThread: vi.fn(),
}));
vi.mock("@beaver/agent-core/transport/threadService", async (importOriginal) => ({
    ...await importOriginal<typeof import("@beaver/agent-core/transport/threadService")>(),
    threadService: api,
    PIN_RECONCILE_TIMEOUT_MS: 100,
}));
import { ThreadRepository } from "../../../src/services/threads/threadRepository";
import { ThreadPresence } from "../../../src/services/threads/threadPresence";
const row = (name = "old") => ({
    id: "t",
    name,
    created_at: "2026-09-01",
    updated_at: "2026-09-02",
    starred: false,
});
const entity = {
    id: "t",
    name: "old",
    createdAt: "2026-09-01",
    updatedAt: "2026-09-02",
    isPinned: false,
};
const params = { key: "u|all", query: "", includeOtherCount: false };
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
};
let repo: ThreadRepository;
beforeEach(() => {
    vi.clearAllMocks();
    repo = new ThreadRepository();
    (Zotero as any).Beaver = { threads: repo, presence: new ThreadPresence() };
});
describe("shared thread cache", () => {
    it("deduplicates concurrent list loads and gives viewers independent snapshot objects", async () => {
        const pending = deferred<any>();
        api.getPaginatedThreads.mockReturnValue(pending.promise);
        let a: any, b: any;
        repo.subscribe((value) => {
            a = value;
        });
        repo.subscribe((value) => {
            b = value;
        });
        const first = repo.loadThreadPage(params);
        await repo.loadThreadPage(params);
        expect(api.getPaginatedThreads).toHaveBeenCalledOnce();
        pending.resolve({ data: [row()], next_cursor: null, has_more: false });
        await first;
        a.entities.get("t").name = "mutated";
        a.views.get(params.key).ids.length = 0;
        expect(b.entities.get("t").name).toBe("old");
        expect(repo.getSnapshot().views.get(params.key)?.ids).toEqual(["t"]);
    });
    it("does not resurrect a deletion or overwrite a rename from a late list response", async () => {
        repo.upsertThreads({ threads: [entity], stamp: repo.stamp() });
        const pending = deferred<any>();
        api.getPaginatedThreads.mockReturnValue(pending.promise);
        const load = repo.loadThreadPage(params);
        repo.patchThread("t", { name: "new" });
        pending.resolve({ data: [row()], next_cursor: null, has_more: false });
        await load;
        expect(repo.getSnapshot().entities.get("t")?.name).toBe("new");
        repo.removeThread("t");
        repo.upsertThreads({ threads: [entity], stamp: repo.stamp() });
        expect(repo.getSnapshot().entities.has("t")).toBe(false);
    });
    it("serializes metadata mutations through settlement and ignores old-account responses", async () => {
        const first = deferred<any>();
        api.renameThread
            .mockReturnValueOnce(first.promise)
            .mockResolvedValueOnce(row("two"));
        const one = repo.renameThread("t", "one");
        const two = repo.renameThread("t", "two");
        await vi.waitFor(() =>
            expect(api.renameThread).toHaveBeenCalledTimes(1),
        );
        first.resolve(row("one"));
        await one;
        await two;
        expect(repo.getSnapshot().entities.get("t")?.name).toBe("two");
        const late = deferred<any>();
        api.renameThread.mockReturnValue(late.promise);
        const operation = repo.renameThread("t", "late");
        await vi.waitFor(() =>
            expect(api.renameThread).toHaveBeenCalledTimes(3),
        );
        repo.resetThreadStore();
        late.resolve(row("late"));
        await operation;
        expect(repo.getSnapshot().entities.size).toBe(0);
    });
    it("rejects a deletion while another window owns the writer claim", async () => {
        Zotero.Beaver.presence.claim("a", "t", 0);
        await expect(repo.deleteThread("t", "b", 0)).rejects.toMatchObject({
            code: "thread_busy",
        });
        expect(api.deleteThread).not.toHaveBeenCalled();
    });
    it("reconciles a confirmed deletion after its requesting window closes", async () => {
        repo.upsertThreads({ threads: [entity], stamp: repo.stamp() });
        const pending = deferred<void>();
        api.deleteThread.mockReturnValue(pending.promise);
        const operation = repo.deleteThread("t", "a", 0);
        expect(api.deleteThread).toHaveBeenCalledWith("t");
        Zotero.Beaver.presence.view("b", "t");
        Zotero.Beaver.presence.detach("a");
        pending.resolve();
        await operation;

        expect(repo.getSnapshot().entities.has("t")).toBe(false);
        expect(Zotero.Beaver.presence.getSnapshot().deleted).toContain("t");
        expect(Zotero.Beaver.presence.claim("b", "t", 0)).toBeNull();
        repo.upsertThreads({ threads: [entity], stamp: repo.stamp() });
        expect(repo.getSnapshot().entities.has("t")).toBe(false);
    });
    it("does not apply an old-account deletion to the replacement cache", async () => {
        const pending = deferred<void>();
        api.deleteThread.mockReturnValue(pending.promise);
        const operation = repo.deleteThread("t", "a", 0);
        repo.resetThreadStore();
        Zotero.Beaver.presence.reset(1);
        repo.upsertThreads({ threads: [entity], stamp: repo.stamp() });
        const successor = Zotero.Beaver.presence.claim("b", "t", 1)!;
        pending.resolve();
        await operation;

        expect(repo.getSnapshot().entities.has("t")).toBe(true);
        expect(Zotero.Beaver.presence.getSnapshot().deleted).toEqual([]);
        expect(Zotero.Beaver.presence.owns(successor)).toBe(true);
    });
    it("ignores foreign-agent realtime inserts and updates, including identity-free pinned rows", () => {
        let event!: (payload: any) => void;
        repo.start({
            subscribe: (listener: any) => {
                listener({ generation: 0, session: { user: { id: "u" } } });
                return vi.fn();
            },
            realtime: { subscribe: (_kind: string, _user: string, callback: typeof event) => {
                event = callback;
                return vi.fn();
            } },
        } as any);
        for (const eventType of ["INSERT", "UPDATE"]) {
            event({ eventType, new: { ...row(), agent_name: "other-agent", starred: true } });
            expect(repo.getSnapshot().entities.size).toBe(0);
        }
        event({ eventType: "INSERT", new: { ...row(), agent_name: "beaver", starred: true } });
        expect(repo.getSnapshot().entities.get("t")?.isPinned).toBe(true);
        event({ eventType: "UPDATE", new: { ...row("foreign"), agent_name: "other-agent" } });
        expect(repo.getSnapshot().entities.get("t")?.name).toBe("old");
        event({ eventType: "INSERT", new: { ...row(), id: "legacy" } });
        expect(repo.getSnapshot().entities.has("legacy")).toBe(true);
    });
    it('subscribes after session acceptance, preserves same-user refresh, and rejects revoked realtime callbacks', () => {
        let notify!: (snapshot: any) => void;
        const events: Array<(payload: any) => void> = [];
        const subscribe = vi.fn((_kind, _user, callback) => { events.push(callback); return vi.fn(); });
        const account = {
            subscribe: (listener: typeof notify) => { notify = listener; listener({ generation: 0, session: null }); return vi.fn(); },
            realtime: { subscribe },
        };
        repo.start(account as any);
        notify({ generation: 1, session: null });
        notify({ generation: 1, session: { user: { id: 'u' } } });
        notify({ generation: 1, session: { user: { id: 'u' }, access_token: 'refreshed' } });
        expect(subscribe).toHaveBeenCalledTimes(1);
        events[0]({ eventType: 'INSERT', new: row('accepted') });
        expect(repo.getSnapshot().entities.get('t')?.name).toBe('accepted');
        notify({ generation: 2, session: null });
        notify({ generation: 2, session: { user: { id: 'other' } } });
        events[0]({ eventType: 'UPDATE', new: row('revoked') });
        expect(repo.getSnapshot().entities.size).toBe(0);
        expect(subscribe).toHaveBeenCalledTimes(2);
    });

    it('copies metadata supplied by a renderer rather than retaining its realm object', () => {
        const supplied = { ...entity };
        repo.upsertThreads({ threads: [supplied], stamp: repo.stamp() });
        supplied.name = 'changed by caller';
        expect(repo.getSnapshot().entities.get('t')?.name).toBe('old');
    });

});
