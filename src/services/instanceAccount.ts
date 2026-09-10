import { InstanceRealtime } from "./instanceRealtime";
import { claimPreSyncThreads } from "./claimPreSyncThreads";
import type { ExcludedLibrary } from "@beaver/agent-core/types/profile";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { SafeProfileWithPlan } from "@beaver/agent-core/types/profile";
import type { ZoteroLibrary } from "@beaver/agent-core/types/zotero";
import { accountService } from "@beaver/agent-core/transport/clients/accountService";
import {
    supabase,
    disposeSupabaseClient,
    setSupabaseAuthPolicy,
    setSupabaseFetchAdapter,
} from "@beaver/agent-core/transport/supabaseClient";
import { setCredentialAdapter } from "@beaver/agent-core/transport/credentials";
import { setTransportConfig } from "@beaver/agent-core/transport/config";
import { registerZoteroSupabaseStorage } from "./zoteroSupabaseStorage";
import { registerZoteroClientIdentity } from "./zoteroClientIdentity";
import { prepareServiceRealm } from "../runtime/realm";
import { getPref, setPref } from "../utils/prefs";
import { libraryRefForLibraryID } from "../utils/libraryIdentity";
import { clearUserScopedPrefs } from "../utils/clearUserScopedPrefs";

type ProfileResponse = Awaited<
    ReturnType<typeof accountService.getProfileWithPlan>
>;
export interface AccountSnapshot {
    generation: number;
    revision: number;
    initialized: boolean;
    authenticating: boolean;
    session: Session | null;
    data: ProfileResponse | null;
    libraries: ZoteroLibrary[];
    scopeReady: boolean;
    migrating: boolean;
    status:
        | { kind: "ok" }
        | {
              kind: "transient";
              message: string;
              attempt: number;
              offline: boolean;
          }
        | { kind: "fatal"; message: string };
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
};

/** One account, refresh pipeline and access authority for the plugin lifetime. */
export class InstanceAccount {
    private snapshot: AccountSnapshot = {
        generation: 0,
        revision: 0,
        initialized: false,
        authenticating: false,
        session: null,
        data: null,
        libraries: [],
        scopeReady: false,
        migrating: false,
        status: { kind: "ok" },
    };
    private listeners = new Set<(snapshot: AccountSnapshot) => void>();
    private disposed = false;
    private authSubscription?: { unsubscribe(): void };
    private timer?: ReturnType<typeof setTimeout>;
    private refreshing?: { generation: number; promise: Promise<void> };
    private refreshAgain = false;
    private attempts = 0;
    private mutationRevision = 0;
    private commandRevision = 0;
    private commands: Promise<unknown> = Promise.resolve();
    private pendingAuth = 0;
    private settingsPending: number | null = null;
    private nextSettingsOperation = 0;
    private signedOut = false;
    private tokenRefresh?: Promise<any>;
    private observingNetwork = false;
    private readonly networkObserver = {
        observe: (_subject: unknown, _topic: string, state: string) => {
            if (this.disposed || !this.snapshot.session) return;
            if (state === "offline") {
                if (this.timer) clearTimeout(this.timer);
                this.timer = undefined;
                this.attempts = 0;
                this.snapshot.status = {
                    kind: "transient",
                    message: "Offline",
                    attempt: 0,
                    offline: true,
                };
                this.publish();
            } else if (state === "online") {
                void this.refresh(true);
            }
        },
    };
    readonly realtime: InstanceRealtime;
    readonly auth: SupabaseClient["auth"];
    readonly client: SupabaseClient;

    constructor(
        private sdk: SupabaseClient = supabase,
        private stopNetwork: () => void = () => {},
    ) {
        this.auth = new Proxy({} as SupabaseClient["auth"], {
            get: (_target, key) => {
                if (
                    ["signOut", "signInWithPassword", "verifyOtp"].includes(
                        String(key),
                    )
                ) {
                    return (...args: unknown[]) =>
                        this.authCommand(String(key), args);
                }
                if (key === "getSession" || key === "refreshSession") {
                    return async (...args: unknown[]) => {
                        const generation = this.snapshot.generation;
                        if (
                            this.pendingAuth ||
                            this.disposed ||
                            (this.snapshot.initialized &&
                                !this.snapshot.session)
                        )
                            return { data: { session: null }, error: null };
                        let pending: Promise<any>;
                        if (key === "refreshSession") {
                            if (!this.tokenRefresh) {
                                const request = this.sdk.auth.refreshSession(
                                    ...(copy(args) as Parameters<
                                        typeof this.sdk.auth.refreshSession
                                    >),
                                );
                                const tracked = request.finally(() => {
                                    if (this.tokenRefresh === tracked)
                                        this.tokenRefresh = undefined;
                                });
                                this.tokenRefresh = tracked;
                            }
                            pending = this.tokenRefresh;
                        } else pending = this.sdk.auth.getSession();
                        const result = await pending;
                        if (
                            generation !== this.snapshot.generation ||
                            this.disposed
                        ) {
                            throw Object.assign(
                                new Error(
                                    "The account changed during authentication",
                                ),
                                { code: "ACCOUNT_CHANGED" },
                            );
                        }
                        return result;
                    };
                }
                const value = Reflect.get(this.sdk.auth, key);
                return typeof value === "function"
                    ? value.bind(this.sdk.auth)
                    : value;
            },
        });
        this.client = new Proxy({} as SupabaseClient, {
            get: (_target, key) => {
                if (key === "auth") return this.auth;
                const value = Reflect.get(this.sdk, key);
                return typeof value === "function"
                    ? value.bind(this.sdk)
                    : value;
            },
        });
        this.realtime = new InstanceRealtime(this.sdk, this.auth, () => ({
            userId: this.snapshot.session?.user.id,
            generation: this.snapshot.generation,
        }));
    }

    start(): void {
        if (this.authSubscription || this.disposed) return;
        if (typeof Services !== "undefined" && Services.obs?.addObserver) {
            Services.obs.addObserver(
                this.networkObserver,
                "network:offline-status-changed",
            );
            this.observingNetwork = true;
        }
        this.authSubscription = this.sdk.auth.onAuthStateChange(
            (event, session) => {
                if (event === "SIGNED_OUT") {
                    if (!this.pendingAuth) this.signedOut = true;
                    Zotero.Beaver?.voice?.authChanged(null);
                }
                if (
                    !this.pendingAuth &&
                    !this.disposed &&
                    (!this.signedOut || !session)
                )
                    this.acceptSession(session);
            },
        ).data.subscription;
    }
    getSnapshot(): AccountSnapshot {
        return copy(this.snapshot);
    }
    getGeneration(): number {
        return this.snapshot.generation;
    }
    subscribe(listener: (snapshot: AccountSnapshot) => void): () => void {
        if (this.disposed) return () => {};
        this.listeners.add(listener);
        try {
            listener(freeze(this.getSnapshot()));
        } catch (error) {
            this.listeners.delete(listener);
            throw error;
        }
        return () => {
            this.listeners.delete(listener);
        };
    }
    private publish(): void {
        this.snapshot.revision++;
        this.publishAccess();
        const snapshot = freeze(this.getSnapshot());
        for (const listener of [...this.listeners]) {
            try {
                listener(snapshot);
            } catch (error) {
                Zotero.logError(error as Error);
            }
        }
    }
    private publishAccess(): void {
        const beaver = Zotero.Beaver;
        if (!beaver) return;
        const profile = this.snapshot.data?.profile;
        const excluded = new Set(
            (profile?.excluded_libraries ?? []).map((entry) =>
                entry.type === "group" ? `group:${entry.group_id}` : "user",
            ),
        );
        const previous = JSON.stringify([
            beaver.libraryScopeInitialized,
            beaver.searchableLibraryIds,
            beaver.hasOcrAccess,
            beaver.hasSearchIndexAccess,
        ]);
        beaver.searchableLibraryIds =
            this.snapshot.scopeReady && this.snapshot.session
                ? this.snapshot.libraries
                      .filter(
                          (lib) =>
                              !excluded.has(
                                  lib.is_group
                                      ? `group:${lib.group_id}`
                                      : "user",
                              ),
                      )
                      .map((lib) => lib.library_id)
                : [];
        beaver.hasOcrAccess =
            !!this.snapshot.session && !!profile?.has_ocr_access;
        beaver.hasSearchIndexAccess =
            !!this.snapshot.session && !!profile?.has_search_index_access;
        beaver.libraryScopeInitialized =
            this.snapshot.scopeReady && !!this.snapshot.session;
        const next = JSON.stringify([
            beaver.libraryScopeInitialized,
            beaver.searchableLibraryIds,
            beaver.hasOcrAccess,
            beaver.hasSearchIndexAccess,
        ]);
        if (previous !== next) {
            beaver.backgroundExtractor?.abortJobsWithoutAccess?.();
            beaver.processingReconciler?.notify();
        }
    }
    private revoke(): void {
        this.realtime.clear();
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.snapshot = {
            ...this.snapshot,
            generation: this.snapshot.generation + 1,
            session: null,
            data: null,
            libraries: [],
            scopeReady: false,
            migrating: false,
            status: { kind: "ok" },
        };
        this.refreshing = undefined;
        this.tokenRefresh = undefined;
        this.settingsPending = null;
        this.refreshAgain = false;
        this.attempts = 0;
        Zotero.Beaver?.voice?.authChanged(null);
        this.publish();
    }
    private acceptSession(session: Session | null): void {
        const changed = this.snapshot.session?.user.id !== session?.user.id;
        if (changed) this.revoke();
        const oldEmail = getPref("userEmail");
        if (session?.user.email && oldEmail && oldEmail !== session.user.email)
            clearUserScopedPrefs();
        this.snapshot.session = copy(session);
        this.snapshot.initialized = true;
        this.publish();
        if (session && (changed || !this.snapshot.data)) this.schedule(0);
    }
    private authCommand(name: string, args: unknown[]): Promise<any> {
        this.signedOut = name === "signOut";
        const revision = ++this.commandRevision;
        this.pendingAuth++;
        this.snapshot.authenticating = true;
        this.revoke();
        const inputs = copy(args);
        const operation = this.commands
            .catch(() => {})
            .then(async () => {
                if (this.disposed || revision !== this.commandRevision)
                    return {
                        data: {},
                        error: {
                            name: "AccountChangedError",
                            code: "ACCOUNT_CHANGED",
                            message: "Authentication was superseded",
                        },
                    };
                return (this.sdk.auth as any)[name](...inputs);
            });
        this.commands = operation;
        return operation
            .finally(async () => {
                this.pendingAuth--;
                this.snapshot.authenticating = this.pendingAuth > 0;
                if (
                    !this.pendingAuth &&
                    !this.disposed &&
                    revision === this.commandRevision
                ) {
                    const { data } = await this.sdk.auth.getSession();
                    if (revision === this.commandRevision)
                        this.acceptSession(
                            this.signedOut ? null : data.session,
                        );
                }
            })
            .then((result) =>
                revision === this.commandRevision
                    ? result
                    : {
                          data: {},
                          error: {
                              name: "AccountChangedError",
                              code: "ACCOUNT_CHANGED",
                              message: "Authentication was superseded",
                          },
                      },
            );
    }
    private schedule(delay: number): void {
        if (this.timer) clearTimeout(this.timer);
        if (this.disposed || !this.snapshot.session || this.isOffline()) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh();
        }, delay);
    }
    private isOffline(): boolean {
        return typeof Services !== "undefined" && Services.io?.offline === true;
    }
    refresh(force = false): Promise<void> {
        if (this.disposed || !this.snapshot.session) return Promise.resolve();
        if (this.isOffline()) {
            this.networkObserver.observe(
                null,
                "network:offline-status-changed",
                "offline",
            );
            return Promise.resolve();
        }
        if (this.refreshing) {
            this.refreshAgain ||= force;
            return this.refreshing.promise;
        }
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        const generation = this.snapshot.generation;
        const mutation = this.mutationRevision;
        const current = () =>
            !this.disposed && generation === this.snapshot.generation;
        const promise = (async () => {
            try {
                let data = await accountService.getProfileWithPlan();
                if (!current()) return;
                if (data.profile.data_version < data.required_data_version) {
                    this.snapshot.migrating = true;
                    this.publish();
                    try {
                        await accountService.migrateData();
                        if (!current()) return;
                        data = await accountService.getProfileWithPlan();
                    } catch (error) {
                        if (
                            (error as any)?.code === "SESSION_EXPIRED" ||
                            (error as any)?.code === "ACCOUNT_CHANGED"
                        )
                            throw error;
                        Zotero.logError(error as Error);
                    }
                }
                if (!current()) return;
                // A profile read started before a settings write cannot restore revoked scope.
                if (
                    mutation !== this.mutationRevision ||
                    this.settingsPending !== null
                ) {
                    this.refreshAgain = this.settingsPending === null;
                    return;
                }
                const libraries = Zotero.Libraries.getAll()
                    .filter(
                        (lib) =>
                            lib.libraryType === "user" ||
                            lib.libraryType === "group",
                    )
                    .map(
                        (lib) =>
                            ({
                                library_id: lib.libraryID,
                                group_id: lib.isGroup ? lib.id : null,
                                library_ref:
                                    libraryRefForLibraryID(lib.libraryID) ??
                                    undefined,
                                name: lib.name,
                                is_group: lib.isGroup,
                                type: lib.libraryType,
                                type_id: lib.libraryTypeID,
                                read_only: !lib.editable || !lib.filesEditable,
                            }) as ZoteroLibrary,
                    );
                const email = this.snapshot.session?.user.email;
                const oldEmail = getPref("userEmail");
                if (email && oldEmail && email !== oldEmail)
                    clearUserScopedPrefs();
                if (email) setPref("userEmail", email);
                if (
                    data.profile.has_authorized_access ||
                    data.profile.has_authorized_free_access
                )
                    setPref("onboardingSignInTextShown", true);
                if (data.profile.user_id !== this.snapshot.session?.user.id)
                    throw new Error("Profile identity mismatch");
                this.snapshot.data = copy(data);
                this.snapshot.libraries = copy(libraries);
                this.snapshot.scopeReady = true;
                this.snapshot.status = { kind: "ok" };
                this.attempts = 0;
                this.publish();
                void this.claimPreSyncThreads();
                this.schedule(15 * 60 * 1000);
            } catch (error) {
                if (!current()) return;
                const e = error as any;
                if (e?.code === "SESSION_EXPIRED") {
                    void this.auth.signOut();
                    return;
                }
                const transient =
                    e?.code === "SESSION_REFRESH_FAILED" ||
                    e?.status === 429 ||
                    e?.status >= 500 ||
                    e?.name === "ServerError";
                this.snapshot.status = transient
                    ? {
                          kind: "transient",
                          message: e?.message ?? String(error),
                          attempt: ++this.attempts,
                          offline: this.isOffline(),
                      }
                    : { kind: "fatal", message: e?.message ?? String(error) };
                this.publish();
                if (transient)
                    this.schedule(
                        Math.min(2000 * 3 ** (this.attempts - 1), 60000),
                    );
            } finally {
                if (current()) {
                    this.snapshot.migrating = false;
                    this.refreshing = undefined;
                    this.publish();
                    if (this.refreshAgain) {
                        this.refreshAgain = false;
                        this.schedule(0);
                    }
                }
            }
        })();
        this.refreshing = { generation, promise };
        return promise;
    }
    async claimPreSyncThreads(): Promise<void> {
        const generation = this.snapshot.generation;
        const userId = this.snapshot.session?.user.id;
        if (!userId) return;
        await claimPreSyncThreads(
            userId,
            () => !this.disposed && generation === this.snapshot.generation,
        );
    }
    async updateExcludedLibraries(entries: ExcludedLibrary[]): Promise<void> {
        if (this.settingsPending !== null || !this.snapshot.data)
            throw new Error(
                "An account settings update is already pending or the profile is unavailable",
            );
        const operation = ++this.nextSettingsOperation;
        this.settingsPending = operation;
        const generation = this.snapshot.generation;
        const previous = copy(
            this.snapshot.data.profile.excluded_libraries ?? [],
        );
        const next = copy(entries);
        this.updateProfile(
            { ...this.snapshot.data.profile, excluded_libraries: next },
            generation,
        );
        try {
            await accountService.updateExcludedLibraries(next);
        } catch (error) {
            if (generation === this.snapshot.generation && this.snapshot.data) {
                this.updateProfile(
                    {
                        ...this.snapshot.data.profile,
                        excluded_libraries: previous,
                    },
                    generation,
                );
            }
            throw error;
        } finally {
            if (this.settingsPending === operation) this.settingsPending = null;
            if (generation === this.snapshot.generation)
                void this.refresh(true);
        }
    }
    async updatePreference(
        preference:
            | "consent_to_share"
            | "use_zotero_sync"
            | "email_notifications",
        value: boolean,
    ): Promise<void> {
        const generation = this.snapshot.generation;
        ++this.mutationRevision;
        await accountService.updatePreference(preference, value);
        if (generation === this.snapshot.generation && this.snapshot.data) {
            this.updateProfile(
                { ...this.snapshot.data.profile, [preference]: value },
                generation,
            );
        }
    }
    revokeSearchIndexAccess(): void {
        if (!this.snapshot.data) return;
        this.updateProfile(
            { ...this.snapshot.data.profile, has_search_index_access: false },
            this.snapshot.generation,
        );
    }
    /** Invalidate any older read after a successful account mutation. */
    async invalidateProfile(): Promise<void> {
        const generation = this.getGeneration();
        this.mutationRevision++;
        // A read already in flight predates the mutation; await a fresh read too.
        await this.refreshing?.promise;
        if (this.disposed || generation !== this.getGeneration())
            throw Object.assign(new Error("Account changed"), {
                code: "ACCOUNT_CHANGED",
            });
        this.refreshAgain = false;
        await this.refresh();
        if (generation !== this.getGeneration())
            throw Object.assign(new Error("Account changed"), {
                code: "ACCOUNT_CHANGED",
            });
        if (this.snapshot.status.kind !== "ok")
            throw new Error(this.snapshot.status.message);
    }
    setExcludedLibrariesForTesting(entries: ExcludedLibrary[]): void {
        if (process.env.NODE_ENV !== "development" || !this.snapshot.data)
            throw new Error("Test access override unavailable");
        this.updateProfile(
            {
                ...this.snapshot.data.profile,
                excluded_libraries: copy(entries),
            },
            this.snapshot.generation,
        );
    }
    /** Apply an account-matching profile update synchronously to every renderer. */
    private updateProfile(
        profile: SafeProfileWithPlan,
        generation: number,
    ): void {
        if (
            this.disposed ||
            generation !== this.snapshot.generation ||
            !this.snapshot.data ||
            profile.user_id !== this.snapshot.data.profile.user_id
        )
            return;
        this.mutationRevision++;
        this.snapshot.data.profile = copy(profile);
        this.publish();
    }
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.revoke();
        this.disposed = true;
        if (this.observingNetwork) {
            Services.obs.removeObserver(
                this.networkObserver,
                "network:offline-status-changed",
            );
            this.observingNetwork = false;
        }
        this.authSubscription?.unsubscribe();
        this.listeners.clear();
        this.stopNetwork();
        await disposeSupabaseClient();
        await this.sdk.removeAllChannels();
    }
}

export function createInstanceAccount(): InstanceAccount {
    prepareServiceRealm();
    setTransportConfig({
        apiBaseUrl: process.env.API_BASE_URL ?? "",
        supabaseUrl: process.env.SUPABASE_URL ?? "",
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
    });
    registerZoteroClientIdentity();
    registerZoteroSupabaseStorage();
    setSupabaseAuthPolicy({ forceAutoRefresh: false });
    const lifetime = new AbortController();
    setSupabaseFetchAdapter((input, init) =>
        fetch(input, { ...init, signal: init?.signal ?? lifetime.signal }),
    );
    const service = new InstanceAccount(supabase, () => lifetime.abort());
    setCredentialAdapter({
        auth: service.auth,
        getGeneration: () => service.getGeneration(),
    });
    return service;
}
