import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@beaver/agent-core/transport/supabaseClient", () => ({
    supabase: {},
}));
vi.mock("@beaver/agent-core/transport/agentService", () => ({
    agentService: { close: vi.fn() },
}));
vi.mock("@beaver/agent-core/transport/providerConnection", () => ({
    providerConnection: { close: vi.fn() },
}));
vi.mock("../../../react/atoms/agentRunAtoms", async () => {
    const { atom } = await import("jotai");
    return {
        clearThreadAtom: atom(null, () => {}),
        abandonActiveRunLocallyAtom: atom(null, () => {}),
    };
});
vi.mock("../../../src/services/librarySuggestionsService", () => ({
    librarySuggestionsService: { getSuggestions: vi.fn() },
}));
import { librarySuggestionsService } from "../../../src/services/librarySuggestionsService";
import { setCredentialAdapter } from "@beaver/agent-core/transport/credentials";
import * as prefs from "../../../src/utils/prefs";
import {
    googleApiKeyAtom,
    openAiApiKeyAtom,
    anthropicApiKeyAtom,
} from "../../../react/atoms/models";
import {
    firstRunSuggestionsAtom,
    firstRunSuggestionsLoadingAtom,
    firstRunSuggestionsErrorAtom,
    loadFirstRunSuggestionsAtom,
} from "../../../react/atoms/firstRun";
import { libraryItemCountAtom } from "../../../react/atoms/zoteroContext";
import { store } from "../../../react/store";
import { attachAccountProjection } from "../../../react/runtime/accountProjection";
import {
    loginStepAtom,
    otpResendCountdownAtom,
    loginLoadingAtom,
    sessionAtom,
} from "../../../react/atoms/auth";

describe("account projection transitions", () => {
    let publish: (snapshot: any) => void;
    let snapshot: any;
    const savedPrefs = new Map<string, any>();
    afterEach(() => {
        setCredentialAdapter(undefined);
        vi.restoreAllMocks();
    });
    beforeEach(() => {
        vi.clearAllMocks();
        savedPrefs.clear();
        vi.spyOn(prefs, "getPref").mockImplementation((key) =>
            savedPrefs.get(key),
        );
        vi.spyOn(prefs, "setPref").mockImplementation((key, value) => {
            savedPrefs.set(key, value);
        });
        setCredentialAdapter({
            auth: {} as any,
            getGeneration: () => snapshot.generation,
        });
        snapshot = {
            generation: 0,
            revision: 0,
            initialized: true,
            authenticating: false,
            session: null,
            data: null,
            libraries: [],
            scopeReady: false,
            migrating: false,
            status: { kind: "ok" },
        };
        Zotero.Beaver = {
            data: { env: "test" },
            account: {
                subscribe: (listener: any) => {
                    publish = listener;
                    listener(snapshot);
                    return () => {};
                },
            },
            runtime: { addWindowCleanup: vi.fn() },
            searchableLibraryIds: [],
        } as any;
        store.set(sessionAtom, null);
        attachAccountProjection({ status: "ready" } as any);
        store.set(loginStepAtom, "otp");
        store.set(otpResendCountdownAtom, 42);
    });
    const emit = (patch: any) => {
        snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 };
        publish(snapshot);
    };
    it("preserves OTP entry and countdown through pending and failed verification", () => {
        emit({ generation: 1, authenticating: true });
        expect(store.get(loginLoadingAtom)).toBe(true);
        expect(store.get(loginStepAtom)).toBe("otp");
        expect(store.get(otpResendCountdownAtom)).toBe(42);
        emit({ authenticating: false });
        expect(store.get(loginLoadingAtom)).toBe(false);
        expect(store.get(loginStepAtom)).toBe("otp");
        expect(store.get(otpResendCountdownAtom)).toBe(42);
    });
    it("resets the form after successful authentication and when an existing account is revoked", () => {
        emit({
            generation: 1,
            session: { user: { id: "a" }, access_token: "token" },
        });
        expect(store.get(loginStepAtom)).toBe("method-selection");
        expect(store.get(otpResendCountdownAtom)).toBe(0);
        store.set(loginStepAtom, "otp");
        store.set(otpResendCountdownAtom, 42);
        emit({ generation: 2, session: null, authenticating: true });
        expect(store.get(loginStepAtom)).toBe("method-selection");
        expect(store.get(otpResendCountdownAtom)).toBe(0);
    });
    it("rehydrates all saved keys after same-account sign-in without preference events", () => {
        const session = { user: { id: "a" }, access_token: "token" };
        const atoms = [googleApiKeyAtom, openAiApiKeyAtom, anthropicApiKeyAtom];
        savedPrefs.set("googleGenerativeAiApiKey", "google-key");
        savedPrefs.set("openAiApiKey", "openai-key");
        savedPrefs.set("anthropicApiKey", "anthropic-key");
        emit({ session });
        expect(atoms.map((atom) => store.get(atom))).toEqual([
            "google-key",
            "openai-key",
            "anthropic-key",
        ]);
        emit({ generation: 1, session: null });
        expect(atoms.map((atom) => store.get(atom))).toEqual(["", "", ""]);
        emit({ generation: 2, authenticating: true });
        emit({ session, authenticating: false });
        expect(atoms.map((atom) => store.get(atom))).toEqual([
            "google-key",
            "openai-key",
            "anthropic-key",
        ]);
    });
    it("reads keys after different-account preference cleanup", () => {
        savedPrefs.set("openAiApiKey", "old-account-key");
        emit({ session: { user: { id: "a" } } });
        expect(store.get(openAiApiKeyAtom)).toBe("old-account-key");
        emit({ generation: 1, session: null, authenticating: true });
        savedPrefs.clear();
        emit({ session: { user: { id: "b" } }, authenticating: false });
        expect(store.get(openAiApiKeyAtom)).toBe("");
    });
    it.each(["resolve", "reject"])(
        "allows the next account to load suggestions while a stale request may %s",
        async (completion) => {
            store.set(libraryItemCountAtom, 20);
            let resolveOld!: (value: any) => void;
            let rejectOld!: (error: Error) => void;
            let resolveNew!: (value: any) => void;
            vi.mocked(librarySuggestionsService.getSuggestions)
                .mockImplementationOnce(
                    () =>
                        new Promise((resolve, reject) => {
                            resolveOld = resolve;
                            rejectOld = reject;
                        }),
                )
                .mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            resolveNew = resolve;
                        }),
                );
            const oldRequest = store.set(loadFirstRunSuggestionsAtom);
            expect(store.get(firstRunSuggestionsLoadingAtom)).toBe(true);
            emit({ generation: 1 });
            expect(store.get(firstRunSuggestionsLoadingAtom)).toBe(false);
            const newRequest = store.set(loadFirstRunSuggestionsAtom);
            expect(
                librarySuggestionsService.getSuggestions,
            ).toHaveBeenCalledTimes(2);
            const response = {
                cards: [],
                facts: { library_size: 20 },
                generated_at: new Date().toISOString(),
            } as any;
            if (completion === "resolve") resolveOld(response);
            else rejectOld(new Error("Old account request failed"));
            await oldRequest;
            expect(store.get(firstRunSuggestionsLoadingAtom)).toBe(true);
            expect(store.get(firstRunSuggestionsAtom)).toBeNull();
            expect(store.get(firstRunSuggestionsErrorAtom)).toBeNull();
            expect(savedPrefs.has("librarySuggestions")).toBe(false);
            resolveNew(response);
            await newRequest;
            expect(store.get(firstRunSuggestionsLoadingAtom)).toBe(false);
            expect(store.get(firstRunSuggestionsAtom)).toEqual(response);
            expect(savedPrefs.has("librarySuggestions")).toBe(true);
        },
    );
});
