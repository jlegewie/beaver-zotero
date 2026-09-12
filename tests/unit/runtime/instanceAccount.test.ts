import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    profile: vi.fn(),
    exclusion: vi.fn(),
    preference: vi.fn(),
    claim: vi.fn(),
    dispose: vi.fn(),
}));
vi.mock("@beaver/agent-core/transport/clients/accountService", () => ({
    accountService: {
        getProfileWithPlan: mocks.profile,
        updateExcludedLibraries: mocks.exclusion,
        updatePreference: mocks.preference,
    },
}));
vi.mock("@beaver/agent-core/transport/threadService", () => ({
    threadService: { claimThreads: mocks.claim },
}));
vi.mock("@beaver/agent-core/transport/supabaseClient", () => ({
    supabase: {},
    disposeSupabaseClient: mocks.dispose,
    setSupabaseAuthPolicy: vi.fn(),
}));
vi.mock("../../../src/services/zoteroSupabaseStorage", () => ({
    registerZoteroSupabaseStorage: vi.fn(),
}));
vi.mock("../../../src/services/zoteroClientIdentity", () => ({
    registerZoteroClientIdentity: vi.fn(),
}));
vi.mock("../../../src/utils/libraryIdentity", () => ({
    libraryRefForLibraryID: () => "u",
}));
vi.mock("../../../src/utils/zoteroInstanceIdentity", () => ({
    getZoteroUserIdentifier: () => ({ localUserKey: "install" }),
}));
import { InstanceAccount } from "../../../src/services/instanceAccount";
import { getPref, setPref } from "../../../src/utils/prefs";

const session = (id = "a", token = "token") =>
    ({ user: { id }, access_token: token, expires_at: 9999999999 }) as any;
const profile = (id = "a") =>
    ({
        profile: {
            user_id: id,
            data_version: 1,
            excluded_libraries: [],
            has_ocr_access: true,
        },
        model_configs: [],
        required_data_version: 1,
        minimum_frontend_version: "0",
    }) as any;
const deferred = <T>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
};

describe("instance account ownership", () => {
    let account: InstanceAccount;
    let event: (event: string, session: any) => void;
    let sdk: any;
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        const prefs = new Map<string, unknown>();
        vi.mocked(Zotero.Prefs.get).mockImplementation((key) => prefs.get(key) as any);
        vi.mocked(Zotero.Prefs.set).mockImplementation((key, value) => { prefs.set(key, value); });
        setPref("backgroundProcessingEnabled", false);
        setPref("backgroundProcessingSearchInitialized", false);
        vi.stubGlobal("Services", {
            io: { offline: false },
            obs: { addObserver: vi.fn(), removeObserver: vi.fn() },
        });
        mocks.profile.mockResolvedValue(profile());
        mocks.exclusion.mockResolvedValue({});
        const beaver = {
            voice: { authChanged: vi.fn() },
            backgroundExtractor: { abortJobsWithoutAccess: vi.fn(), notify: vi.fn() },
            processingReconciler: { notify: vi.fn() },
        };
        (Zotero as any).Beaver = beaver;
        (Zotero.Libraries.getAll as any).mockReturnValue([
            {
                libraryID: 1,
                libraryType: "user",
                name: "Library",
                editable: true,
                filesEditable: true,
            },
        ]);
        sdk = {
            auth: {
                onAuthStateChange: vi.fn((callback) => {
                    event = callback;
                    return { data: { subscription: { unsubscribe: vi.fn() } } };
                }),
                getSession: vi.fn().mockResolvedValue({
                    data: { session: session() },
                    error: null,
                }),
                refreshSession: vi.fn().mockResolvedValue({
                    data: { session: session("a", "refreshed") },
                    error: null,
                }),
                signOut: vi.fn().mockResolvedValue({ error: null }),
            },
            removeAllChannels: vi.fn().mockResolvedValue([]),
        };
        account = new InstanceAccount(sdk);
        account.start();
    });
    afterEach(async () => {
        await account.dispose();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });
    const load = async () => {
        event("INITIAL_SESSION", session());
        await account.refresh();
    };
    it("coalesces rejection verification and retains valid credentials", async () => {
        await load();
        const pending = deferred<any>();
        mocks.profile.mockReturnValueOnce(pending.promise);
        const generation = account.getGeneration();
        const checks = Array.from({ length: 8 }, () => account.reportSessionRejected(generation));
        expect(mocks.profile).toHaveBeenCalledTimes(2);
        pending.resolve(profile());
        await Promise.all(checks);
        await account.reportSessionRejected(generation);
        await vi.advanceTimersByTimeAsync(100);
        expect(mocks.profile).toHaveBeenCalledTimes(2);
        expect(sdk.auth.signOut).not.toHaveBeenCalled();
        expect(account.getSnapshot().session).not.toBeNull();
    });

    it("joins an existing profile refresh without scheduling another verification", async () => {
        await load();
        const pending = deferred<any>();
        mocks.profile.mockReturnValueOnce(pending.promise);
        const refresh = account.refresh();
        const check = account.reportSessionRejected(account.getGeneration());
        pending.resolve(profile());
        await Promise.all([refresh, check]);
        await account.reportSessionRejected(account.getGeneration());
        await vi.advanceTimersByTimeAsync(100);
        expect(mocks.profile).toHaveBeenCalledTimes(2);
    });

    it("preserves the session when the network drops during verification", async () => {
        await load();
        const pending = deferred<any>();
        mocks.profile.mockReturnValueOnce(pending.promise);
        const check = account.reportSessionRejected(account.getGeneration());
        Services.io.offline = true;
        pending.reject({ code: "SESSION_EXPIRED" });
        await check;
        expect(sdk.auth.signOut).not.toHaveBeenCalled();
        expect(account.getSnapshot().status).toMatchObject({ kind: "transient", offline: true });
    });

    it("signs out only after a current verification confirms rejection", async () => {
        await load();
        mocks.profile.mockRejectedValueOnce({ code: "SESSION_EXPIRED" });
        await account.reportSessionRejected(account.getGeneration());
        expect(account.getSnapshot().session).toBeNull();
        await vi.advanceTimersByTimeAsync(0);
        expect(sdk.auth.signOut).toHaveBeenCalledTimes(1);
    });

    it("ignores obsolete rejection reports and verification results", async () => {
        await load();
        const generation = account.getGeneration();
        const pending = deferred<any>();
        mocks.profile.mockReturnValueOnce(pending.promise);
        const check = account.reportSessionRejected(generation);
        event("SIGNED_IN", session("b"));
        pending.reject({ code: "SESSION_EXPIRED" });
        await check;
        await account.reportSessionRejected(generation);
        expect(mocks.profile).toHaveBeenCalledTimes(2);
        expect(account.getSnapshot().session?.user.id).toBe("b");
        expect(sdk.auth.signOut).not.toHaveBeenCalled();
    });

    it.each([
        { code: "SESSION_REFRESH_FAILED", message: "Network failed" },
        { status: 429, message: "Rate limited" },
        { status: 503, message: "Unavailable" },
    ])("preserves outage backoff despite repeated rejection reports: %j", async error => {
        await load();
        mocks.profile.mockRejectedValue(error);
        const generation = account.getGeneration();
        await account.reportSessionRejected(generation);
        for (let i = 0; i < 5; i++) await account.reportSessionRejected(generation);
        expect(mocks.profile).toHaveBeenCalledTimes(2);
        expect(account.getSnapshot().status.kind).toBe("transient");
        expect(sdk.auth.signOut).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        expect(mocks.profile).toHaveBeenCalledTimes(3);
    });

    it("does not verify or sign out offline", async () => {
        await load();
        Services.io.offline = true;
        await account.reportSessionRejected(account.getGeneration());
        expect(mocks.profile).toHaveBeenCalledTimes(1);
        expect(sdk.auth.signOut).not.toHaveBeenCalled();
    });

    it("initializes search processing without a renderer and preserves a later pause", async () => {
        await load();
        expect(getPref("backgroundProcessingEnabled")).toBe(false);
        expect(getPref("backgroundProcessingSearchInitialized")).toBe(false);

        const entitled = profile();
        entitled.profile.has_search_index_access = true;
        mocks.profile.mockResolvedValue(entitled);
        vi.mocked(Zotero.Beaver.backgroundExtractor!.notify).mockClear();
        await account.refresh();
        expect(Zotero.Beaver.hasSearchIndexAccess).toBe(true);
        expect(getPref("backgroundProcessingEnabled")).toBe(true);
        expect(getPref("backgroundProcessingSearchInitialized")).toBe(true);
        expect(Zotero.Beaver.backgroundExtractor!.notify).toHaveBeenCalledOnce();

        setPref("backgroundProcessingEnabled", false);
        vi.mocked(Zotero.Beaver.backgroundExtractor!.notify).mockClear();
        event("TOKEN_REFRESHED", session("a", "rotated"));
        await account.refresh();
        expect(getPref("backgroundProcessingEnabled")).toBe(false);
        expect(Zotero.Beaver.backgroundExtractor!.notify).not.toHaveBeenCalled();

        mocks.profile.mockResolvedValue(profile());
        await account.refresh();
        expect(Zotero.Beaver.hasSearchIndexAccess).toBe(false);
        expect(Zotero.Beaver.backgroundExtractor!.notify).toHaveBeenCalledOnce();
        mocks.profile.mockResolvedValue(entitled);
        await account.refresh();
        expect(getPref("backgroundProcessingEnabled")).toBe(false);
        expect(Zotero.Beaver.backgroundExtractor!.notify).toHaveBeenCalledTimes(2);
    });
    it("starts one SDK listener and hydrates subscribers without an update gap", async () => {
        account.start();
        await load();
        const seen: any[] = [];
        account.subscribe((value) => seen.push(value));
        expect(sdk.auth.onAuthStateChange).toHaveBeenCalledTimes(1);
        expect(seen[0].data.profile.user_id).toBe("a");
        expect(() =>
            seen[0].data.profile.excluded_libraries.push({ type: "user" }),
        ).toThrow();
        expect(account.getSnapshot().data?.profile.excluded_libraries).toEqual(
            [],
        );
    });
    it("preserves the account generation and loaded profile on same-user token rotation", async () => {
        await load();
        const before = account.getSnapshot();
        event("TOKEN_REFRESHED", session("a", "rotated"));
        expect(account.getGeneration()).toBe(before.generation);
        expect(account.getSnapshot().data).toEqual(before.data);
        expect(account.getSnapshot().session?.access_token).toBe("rotated");
    });
    it("continues refreshing after every renderer unsubscribes", async () => {
        await load();
        const remove = account.subscribe(() => {});
        remove();
        const count = mocks.profile.mock.calls.length;
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
        expect(mocks.profile.mock.calls.length).toBeGreaterThan(count);
        expect(account.getSnapshot().data).not.toBeNull();
    });
    it("pauses offline retries and resumes through one instance network observer", async () => {
        await load();
        account.start();
        expect(Services.obs.addObserver).toHaveBeenCalledTimes(1);
        const observer = vi.mocked(Services.obs.addObserver).mock
            .calls[0][0] as any;
        Services.io.offline = true;
        observer.observe(null, "network:offline-status-changed", "offline");
        const calls = mocks.profile.mock.calls.length;
        await account.refresh(true);
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
        expect(mocks.profile).toHaveBeenCalledTimes(calls);
        expect(account.getSnapshot().status).toMatchObject({
            kind: "transient",
            offline: true,
            attempt: 0,
        });
        expect(account.getSnapshot().scopeReady).toBe(true);
        Services.io.offline = false;
        observer.observe(null, "network:offline-status-changed", "online");
        await account.refresh();
        expect(mocks.profile).toHaveBeenCalledTimes(calls + 1);
        expect(account.getSnapshot().status.kind).toBe("ok");
        await account.dispose();
        expect(Services.obs.removeObserver).toHaveBeenCalledWith(
            observer,
            "network:offline-status-changed",
        );
    });
    it("shares an immutable publication and avoids access work on token-only updates", async () => {
        await load();
        const first = vi.fn();
        const second = vi.fn();
        account.subscribe(first);
        account.subscribe(second);
        vi.mocked(
            Zotero.Beaver.backgroundExtractor!.abortJobsWithoutAccess,
        ).mockClear();
        vi.mocked(Zotero.Beaver.processingReconciler!.notify).mockClear();
        event("TOKEN_REFRESHED", session("a", "next"));
        const published = first.mock.calls.at(-1)![0];
        expect(published).toBe(second.mock.calls.at(-1)![0]);
        expect(() =>
            published.data.profile.excluded_libraries.push({ type: "user" }),
        ).toThrow();
        expect(
            Zotero.Beaver.backgroundExtractor!.abortJobsWithoutAccess,
        ).not.toHaveBeenCalled();
        expect(
            Zotero.Beaver.processingReconciler!.notify,
        ).not.toHaveBeenCalled();
    });
    it("awaits a fresh profile when invalidation supersedes a pending read", async () => {
        await load();
        const old = deferred<any>();
        const fresh = deferred<any>();
        mocks.profile
            .mockReturnValueOnce(old.promise)
            .mockReturnValueOnce(fresh.promise);
        const reading = account.refresh();
        let completed = false;
        const invalidation = account.invalidateProfile().then(() => {
            completed = true;
        });
        old.resolve(profile());
        await reading;
        await Promise.resolve();
        expect(completed).toBe(false);
        const next = profile();
        next.profile.has_completed_onboarding = true;
        fresh.resolve(next);
        await invalidation;
        expect(
            account.getSnapshot().data?.profile.has_completed_onboarding,
        ).toBe(true);
    });
    it("discards a profile response from the previous account, including an ABA switch", async () => {
        await load();
        const pending = deferred<any>();
        mocks.profile.mockReturnValueOnce(pending.promise);
        const refresh = account.refresh();
        event("SIGNED_IN", session("b"));
        event("SIGNED_IN", session("a"));
        pending.resolve(profile());
        await refresh;
        expect(account.getSnapshot().data).toBeNull();
        expect(Zotero.Beaver.libraryScopeInitialized).toBe(false);
    });
    it.each(["Invalid OTP", "Network unavailable"])(
        "publishes a signed-out pending attempt and settles a failed verification: %s",
        async (message) => {
            event("INITIAL_SESSION", null);
            const pending = deferred<any>();
            sdk.auth.verifyOtp = vi.fn().mockReturnValue(pending.promise);
            sdk.auth.getSession.mockResolvedValue({
                data: { session: null },
                error: null,
            });
            const before = account.getGeneration();
            const attempt = account.auth.verifyOtp({
                email: "test@example.test",
                token: "123456",
                type: "email",
            });
            expect(account.getSnapshot()).toMatchObject({
                generation: before + 1,
                authenticating: true,
                session: null,
            });
            pending.resolve({ data: { session: null }, error: { message } });
            await expect(attempt).resolves.toMatchObject({
                error: { message },
            });
            expect(account.getSnapshot()).toMatchObject({
                generation: before + 1,
                authenticating: false,
                session: null,
            });
        },
    );
    it("revokes access and voice synchronously before sign-out waits for the SDK", async () => {
        await load();
        const pending = deferred<any>();
        sdk.auth.signOut.mockReturnValueOnce(pending.promise);
        sdk.auth.getSession.mockResolvedValue({
            data: { session: null },
            error: null,
        });
        const logout = account.auth.signOut();
        expect(Zotero.Beaver.searchableLibraryIds).toEqual([]);
        expect(Zotero.Beaver.hasOcrAccess).toBe(false);
        expect(Zotero.Beaver.voice?.authChanged).toHaveBeenCalledWith(null);
        expect(account.getSnapshot().session).toBeNull();
        pending.resolve({ error: null });
        await logout;
    });
    it("revokes scope before notifying renderers and before the preference request finishes", async () => {
        await load();
        const pending = deferred<any>();
        mocks.exclusion.mockReturnValueOnce(pending.promise);
        let scope: number[] | undefined;
        account.subscribe((s) => {
            if (s.data?.profile.excluded_libraries.length)
                scope = Zotero.Beaver.searchableLibraryIds;
        });
        const write = account.updateExcludedLibraries([{ type: "user" }]);
        expect(scope).toEqual([]);
        expect(
            Zotero.Beaver.backgroundExtractor?.abortJobsWithoutAccess,
        ).toHaveBeenCalled();
        pending.resolve({});
        await write;
    });
    it("cannot restore excluded scope from a profile fetch started before the write", async () => {
        await load();
        const pending = deferred<any>();
        const writePending = deferred<any>();
        mocks.profile.mockReturnValueOnce(pending.promise);
        mocks.exclusion.mockReturnValueOnce(writePending.promise);
        const refresh = account.refresh();
        const write = account.updateExcludedLibraries([{ type: "user" }]);
        pending.resolve(profile());
        await refresh;
        expect(Zotero.Beaver.searchableLibraryIds).toEqual([]);
        writePending.resolve({});
        await write;
    });
    it("rejects concurrent settings writes and never rolls back into a different account", async () => {
        await load();
        const pending = deferred<any>();
        mocks.exclusion.mockReturnValueOnce(pending.promise);
        const write = account.updateExcludedLibraries([{ type: "user" }]);
        await expect(account.updateExcludedLibraries([])).rejects.toThrow(
            "pending",
        );
        event("SIGNED_IN", session("b"));
        pending.reject(new Error("offline"));
        await expect(write).rejects.toThrow("offline");
        expect(account.getSnapshot().data).toBeNull();
    });
    it("does not apply a profile whose identity differs from the authenticated account", async () => {
        mocks.profile.mockResolvedValue(profile("b"));
        await load();
        expect(account.getSnapshot().data).toBeNull();
        expect(account.getSnapshot().status.kind).toBe("fatal");
    });
    it("rejects a credential result that crosses an account generation", async () => {
        await load();
        const pending = deferred<any>();
        sdk.auth.getSession.mockReturnValueOnce(pending.promise);
        const request = account.auth.getSession();
        event("SIGNED_IN", session("b"));
        pending.resolve({ data: { session: session() }, error: null });
        await expect(request).rejects.toMatchObject({
            code: "ACCOUNT_CHANGED",
        });
    });
    it("preserves the profile and schedules retry for a structural transient error", async () => {
        await load();
        mocks.profile.mockRejectedValueOnce({
            code: "SESSION_REFRESH_FAILED",
            message: "Offline",
        });
        await account.refresh();
        expect(account.getSnapshot().data).not.toBeNull();
        expect(account.getSnapshot().status.kind).toBe("transient");
        await vi.advanceTimersByTimeAsync(2000);
        expect(account.getSnapshot().status.kind).toBe("ok");
    });
    it("coalesces concurrent explicit token refreshes", async () => {
        await load();
        const pending = deferred<any>();
        sdk.auth.refreshSession.mockReturnValueOnce(pending.promise);
        const first = account.auth.refreshSession(),
            second = account.auth.refreshSession();
        expect(sdk.auth.refreshSession).toHaveBeenCalledOnce();
        pending.resolve({
            data: { session: session("a", "rotated") },
            error: null,
        });
        await Promise.all([first, second]);
    });
    it("does not restore access from a late SDK event after sign-out", async () => {
        await load();
        sdk.auth.getSession.mockResolvedValue({
            data: { session: null },
            error: null,
        });
        await account.auth.signOut();
        event("TOKEN_REFRESHED", session());
        expect(account.getSnapshot().session).toBeNull();
        expect((await account.auth.getSession()).data.session).toBeNull();
    });
    it("allows the new account to update settings while an old-account save is pending", async () => {
        await load();
        const pending = deferred<any>();
        mocks.exclusion.mockReturnValueOnce(pending.promise);
        const oldWrite = account.updateExcludedLibraries([{ type: "user" }]);
        event("SIGNED_IN", session("b"));
        mocks.profile.mockResolvedValue(profile("b"));
        await account.refresh();
        await account.updateExcludedLibraries([]);
        pending.reject(new Error("Old write failed"));
        await expect(oldWrite).rejects.toThrow("Old write failed");
        expect(account.getSnapshot().data?.profile.user_id).toBe("b");
        expect(account.getSnapshot().data?.profile.excluded_libraries).toEqual(
            [],
        );
    });
    it("removes a subscriber whose initial hydration throws", () => {
        const listener = vi.fn(() => {
            throw new Error("Renderer failed");
        });
        expect(() => account.subscribe(listener)).toThrow("Renderer failed");
        event("INITIAL_SESSION", null);
        expect(listener).toHaveBeenCalledOnce();
    });
    it("disposes once and ignores late refresh completions", async () => {
        await load();
        const pending = deferred<any>();
        mocks.profile.mockReturnValueOnce(pending.promise);
        const refresh = account.refresh();
        await account.dispose();
        await account.dispose();
        pending.resolve(profile());
        await refresh;
        expect(account.getSnapshot().data).toBeNull();
        expect(sdk.removeAllChannels).toHaveBeenCalledTimes(1);
    });
});
