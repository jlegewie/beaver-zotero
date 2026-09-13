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
    it("marks a thread deleted for every viewer when a fetch reports it gone", () => {
        repo.upsertThreads({ threads: [entity, { ...entity, id: "t2" }], stamp: repo.stamp() });
        // A deletion this instance only learns of from a failed fetch.
        repo.markThreadDeleted("t2");
        expect(repo.getSnapshot().entities.has("t2")).toBe(false);
        expect(repo.getSnapshot().entities.has("t")).toBe(true);
        expect(Zotero.Beaver.presence.getSnapshot().deleted).toEqual(["t2"]);
        expect(Zotero.Beaver.presence.claim("a", "t2", 0)).toBeNull();
        // It does not come back through a late list response.
        repo.upsertThreads({ threads: [{ ...entity, id: "t2", name: "late" }], stamp: repo.stamp() });
        expect(repo.getSnapshot().entities.has("t2")).toBe(false);
    });
    it("propagates a rename to every subscriber and marks their views stale", async () => {
        api.renameThread.mockResolvedValue({ ...row("renamed") });
        repo.upsertThreads({ threads: [entity], stamp: repo.stamp() });
        const views = new Map([[params.key, { ids: ["t"], cursor: null, hasMore: false, otherInstanceCount: null, pinnedLoadedAt: Date.now(), status: "ready" as const, error: null, loadedAt: Date.now() }]]);
        (repo as any).views = views;
        const seen: string[] = [];
        repo.subscribe((snapshot) => { seen.push(snapshot.entities.get("t")?.name ?? ""); });
        await repo.renameThread("t", "renamed");
        expect(seen.at(-1)).toBe("renamed");
        expect(repo.getSnapshot().views.get(params.key)!.loadedAt).toBeLessThan(0);
    });
    it('resets the cache and presence on account replacement, preserving same-user refresh, and never opens a realtime channel', () => {
        let notify!: (snapshot: any) => void;
        const subscribe = vi.fn();
        const account = {
            subscribe: (listener: typeof notify) => { notify = listener; listener({ generation: 0, session: null }); return vi.fn(); },
            realtime: { subscribe },
        };
        repo.start(account as any);
        notify({ generation: 1, session: { user: { id: 'u' } } });
        repo.upsertThreads({ threads: [entity], stamp: repo.stamp() });
        const claim = Zotero.Beaver.presence.claim('a', 't', 1);
        notify({ generation: 1, session: { user: { id: 'u' }, access_token: 'refreshed' } });
        expect(repo.getSnapshot().entities.has('t')).toBe(true);
        expect(claim && Zotero.Beaver.presence.owns(claim)).toBe(true);
        notify({ generation: 2, session: { user: { id: 'other' } } });
        expect(repo.getSnapshot().entities.size).toBe(0);
        expect(Zotero.Beaver.presence.getSnapshot().claims).toEqual([]);
        expect(subscribe).not.toHaveBeenCalled();
    });

    it('copies metadata supplied by a renderer rather than retaining its realm object', () => {
        const supplied = { ...entity };
        repo.upsertThreads({ threads: [supplied], stamp: repo.stamp() });
        supplied.name = 'changed by caller';
        expect(repo.getSnapshot().entities.get('t')?.name).toBe('old');
    });

});
