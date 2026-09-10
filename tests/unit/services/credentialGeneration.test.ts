import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiService } from "@beaver/agent-core/transport/apiService";
import { setCredentialAdapter } from "@beaver/agent-core/transport/credentials";
import {
    isApiError,
    isSessionExpiredError,
    isSessionRefreshError,
} from "@beaver/agent-core/types/apiErrors";

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
afterEach(() => {
    setCredentialAdapter(undefined);
    vi.unstubAllGlobals();
});
describe("account generation boundaries", () => {
    function setup() {
        let generation = 1;
        const auth = {
            getSession: vi
                .fn()
                .mockResolvedValue({
                    data: { session: { access_token: "token" } },
                    error: null,
                }),
            refreshSession: vi.fn(),
        };
        setCredentialAdapter({
            auth: auth as any,
            getGeneration: () => generation,
        });
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        return {
            auth,
            fetch,
            change: () => {
                generation++;
            },
            api: new ApiService("https://test.invalid"),
        };
    }
    it("never dispatches a request after account replacement during credential lookup", async () => {
        const s = setup(),
            pending = deferred<any>();
        s.auth.getSession.mockReturnValueOnce(pending.promise);
        const request = s.api.get("/pending");
        s.change();
        pending.resolve({
            data: { session: { access_token: "old" } },
            error: null,
        });
        await expect(request).rejects.toMatchObject({
            code: "ACCOUNT_CHANGED",
        });
        expect(s.fetch).not.toHaveBeenCalled();
    });
    it("does not refresh or retry an old-account 401 using the new account", async () => {
        const s = setup(),
            pending = deferred<Response>();
        s.fetch.mockReturnValue(pending.promise);
        const request = s.api.get("/pending");
        await vi.waitFor(() => expect(s.fetch).toHaveBeenCalledOnce());
        s.change();
        pending.resolve(new Response("", { status: 401 }));
        await expect(request).rejects.toMatchObject({
            code: "ACCOUNT_CHANGED",
        });
        expect(s.auth.refreshSession).not.toHaveBeenCalled();
    });
    it("rejects old data when the account changes while the response body is pending", async () => {
        const s = setup(),
            pending = deferred<string>();
        const text = vi.fn(() => pending.promise);
        s.fetch.mockResolvedValue({ ok: true, status: 200, text });
        const request = s.api.get("/pending");
        await vi.waitFor(() => expect(text).toHaveBeenCalledOnce());
        s.change();
        pending.resolve('{"secret":"old account"}');
        await expect(request).rejects.toMatchObject({
            code: "ACCOUNT_CHANGED",
        });
    });
    it("does not classify an old error body against the new account", async () => {
        const s = setup(),
            pending = deferred<string>();
        const text = vi.fn(() => pending.promise);
        s.fetch.mockResolvedValue({
            ok: false,
            status: 403,
            statusText: "Forbidden",
                message: "Request failed",
            text,
        });
        const request = s.api.get("/pending");
        await vi.waitFor(() => expect(text).toHaveBeenCalledOnce());
        s.change();
        pending.resolve('{"detail":"Old account error"}');
        await expect(request).rejects.toMatchObject({
            code: "ACCOUNT_CHANGED",
        });
    });
    it("classifies structural errors without sharing their constructor", () => {
        expect(isApiError(new Response(null, { status: 403 }))).toBe(false);
        expect(
            isSessionExpiredError({
                status: 401,
                statusText: "Unauthorized",
                message: "Request failed",
                code: "SESSION_EXPIRED",
            }),
        ).toBe(true);
        expect(
            isSessionRefreshError({
                status: 503,
                statusText: "Unavailable",
                message: "Request failed",
                code: "SESSION_REFRESH_FAILED",
            }),
        ).toBe(true);
        expect(
            isApiError({
                status: 403,
                statusText: "Forbidden",
                message: "Request failed",
                code: "NOT_ALLOWED",
            }),
        ).toBe(true);
        expect(isSessionExpiredError({ name: "SessionExpiredError" })).toBe(
            false,
        );
    });
    it("two separately evaluated renderer modules delegate to one host client", async () => {
        const host = {
            auth: {
                getSession: vi
                    .fn()
                    .mockResolvedValue({ data: { session: null } }),
            },
        } as any;
        vi.resetModules();
        const first =
            await import("@beaver/agent-core/transport/supabaseClient");
        first.setSupabaseClientProvider(() => host);
        vi.resetModules();
        const second =
            await import("@beaver/agent-core/transport/supabaseClient");
        second.setSupabaseClientProvider(() => host);
        expect(first.supabase).not.toBe(second.supabase);
        expect(first.supabase.auth).toBe(second.supabase.auth);
        await first.supabase.auth.getSession();
        await second.supabase.auth.getSession();
        expect(host.auth.getSession).toHaveBeenCalledTimes(2);
    });
});
