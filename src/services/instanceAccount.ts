import { InstanceRealtime } from "./instanceRealtime";
import { readCloudConsent, writeCloudConsent } from "./backgroundProcessing/cloudConsent";
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
import { setTransportConfig, getTransportConfig } from "@beaver/agent-core/transport/config";
import { isCredentialsBlockedError } from "@beaver/agent-core/types/apiErrors";
import {
    CONNECTION_TROUBLESHOOTING_URL,
    CREDENTIALS_BLOCKED_MESSAGE,
    CREDENTIALS_BLOCKED_TITLE,
} from "@beaver/agent-core/transport/connectionFailure";
import { registerZoteroSupabaseStorage } from "./zoteroSupabaseStorage";
import { registerZoteroClientIdentity } from "./zoteroClientIdentity";
import { prepareServiceRealm } from "../runtime/realm";
import { getPref, setPref } from "../utils/prefs";
import { libraryRefForLibraryID } from "../utils/libraryIdentity";
import { clearUserScopedPrefs } from "../utils/clearUserScopedPrefs";
import {
    describeAuthError,
    getAuthDiagnostics,
    recordAuthDiagnostic,
    type AuthDiagnosticEntry,
} from "./authDiagnostics";

type ProfileResponse = Awaited<
    ReturnType<typeof accountService.getProfileWithPlan>
>;
export interface AccountSnapshot {
    cloudConsent?: "pending" | "declined" | "accepted";
    generation: number;
    revision: number;
    initialized: boolean;
    authenticating: boolean;
    session: Session | null;
    data: ProfileResponse | null;
    libraries: ZoteroLibrary[];
    scopeReady: boolean;
    migrating: boolean;
    /**
     * Set while the saved session is still being restored and the first
     * attempt has failed or is taking long. The session stays saved, the
     * account stays uninitialized, and restoring retries until it succeeds,
     * the auth server rejects the session, or the user chooses to sign in.
     * `attempt` 0 means the first restore is still running.
     */
    restore: SessionRestoreState | null;
    status:
        | { kind: "ok" }
        | {
              kind: "transient";
              message: string;
              attempt: number;
              offline: boolean;
          }
        | {
              kind: "fatal";
              message: string;
              /** Replaces the generic heading when the cause is known. */
              title?: string;
              /** Documentation the user can act on, rendered as a link. */
              helpUrl?: string;
          };
}
export interface SessionRestoreState {
    attempt: number;
    offline: boolean;
    /** Why the last attempt failed, for diagnostics. Empty while the first attempt runs. */
    message: string;
}
/** How long the first restore may run before the UI offers to sign in instead. */
const RESTORE_SLOW_MS = 15_000;
/** Delay before restore attempt `attempt + 1`, after `attempt` failures. */
const restoreRetryDelay = (attempt: number): number =>
    Math.min(5_000 * 3 ** (attempt - 1), 60_000);
/** Profile refresh cadence while a Beaver surface is showing in any window. */
const VISIBLE_REFRESH_MS = 15 * 60 * 1000;
/** Profile refresh cadence while Beaver is hidden everywhere; plan changes still land. */
const HIDDEN_REFRESH_MS = 4 * 60 * 60 * 1000;
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
        restore: null,
        status: { kind: "ok" },
    };
    private listeners = new Set<(snapshot: AccountSnapshot) => void>();
    private disposed = false;
    private authSubscription?: { unsubscribe(): void };
    private timer?: ReturnType<typeof setTimeout>;
    /** Whether `timer` is the periodic refresh (re-timed on visibility changes) or a retry. */
    private periodic = false;
    private lastSuccessAt = 0;
    /** Renderers currently showing a Beaver surface, keyed by window runtime id. */
    private visibleSurfaces = new Set<string>();
    private refreshing?: { generation: number; promise: Promise<void> };
    private refreshAgain = false;
    private attempts = 0;
    private rejectionCheckAfter = 0;
    private mutationRevision = 0;
    private commandRevision = 0;
    private commands: Promise<unknown> = Promise.resolve();
    private pendingAuth = 0;
    private settingsPending: number | null = null;
    private nextSettingsOperation = 0;
    private signedOut = false;
    private tokenRefresh?: Promise<any>;
    private restoreTimer?: ReturnType<typeof setTimeout>;
    private slowRestoreTimer?: ReturnType<typeof setTimeout>;
    private restoring?: Promise<void>;
    /** Bumped when restoring ends, so a late attempt result cannot apply. */
    private restoreRun = 0;
    /** Whether restoring went beyond the SDK's first answer, so its outcome is worth recording. */
    private restoreStarted = false;
    /** Set when the user chose to sign in instead, until any session arrives. */
    private restoreAbandoned = false;
    private observingNetwork = false;
    private readonly networkObserver = {
        observe: (_subject: unknown, _topic: string, state: string) => {
            if (this.disposed) return;
            if (!this.snapshot.initialized) {
                this.restoreNetworkChanged(state);
                return;
            }
            if (!this.snapshot.session) return;
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
                    // `signedOut` is set by the sign-out command before it runs.
                    recordAuthDiagnostic(
                        "signed_out",
                        !this.pendingAuth
                            ? "session discarded by the SDK"
                            : this.signedOut
                              ? "sign-out command"
                              : "during sign-in",
                    );
                }
                if (event === "INITIAL_SESSION")
                    recordAuthDiagnostic(
                        session ? "initial_session_restored" : "initial_session_empty",
                    );
                // The SDK reports no initial session both when nothing is saved
                // and when restoring a saved one failed for a transient reason
                // (it keeps the session and retries). Ask again before showing
                // sign-in, so a slow network is not mistaken for a sign-out.
                if (
                    event === "INITIAL_SESSION" &&
                    !session &&
                    !this.snapshot.initialized &&
                    !this.pendingAuth &&
                    !this.disposed
                ) {
                    void this.restoreSession();
                    return;
                }
                if (
                    !this.pendingAuth &&
                    !this.disposed &&
                    (!this.signedOut || !session)
                )
                    this.acceptSession(session);
            },
        ).data.subscription;
        this.slowRestoreTimer = setTimeout(() => {
            this.slowRestoreTimer = undefined;
            if (this.disposed || this.snapshot.initialized || this.snapshot.restore)
                return;
            this.restoreStarted = true;
            recordAuthDiagnostic("restore_slow");
            this.snapshot.restore = {
                attempt: 0,
                offline: this.isOffline(),
                message: "",
            };
            this.publish();
        }, RESTORE_SLOW_MS);
    }
    /**
     * Ask the SDK for the saved session while the account is uninitialized.
     * A session or a definite "none saved" ends restoring; an error means the
     * SDK kept the session (it deletes it, and reports SIGNED_OUT, when the
     * auth server rejects it), so restoring continues with backoff.
     */
    private restoreSession(): Promise<void> {
        if (this.restoring) return this.restoring;
        if (this.disposed || this.snapshot.initialized) return Promise.resolve();
        this.restoreStarted = true;
        if (this.restoreTimer) clearTimeout(this.restoreTimer);
        this.restoreTimer = undefined;
        const run = this.restoreRun;
        const current = () =>
            !this.disposed &&
            run === this.restoreRun &&
            !this.snapshot.initialized &&
            !this.pendingAuth;
        const promise = (async () => {
            let result: { data?: { session: Session | null }; error?: unknown };
            try {
                result = await this.sdk.auth.getSession();
            } catch (error) {
                result = { error };
            }
            if (!current()) return;
            const restored = result.data?.session ?? null;
            if (restored) {
                this.acceptSession(restored);
                return;
            }
            if (!result.error) {
                recordAuthDiagnostic("restore_found_no_session");
                this.acceptSession(null);
                return;
            }
            const attempt = (this.snapshot.restore?.attempt ?? 0) + 1;
            const message = describeAuthError(result.error);
            recordAuthDiagnostic("restore_failed", `attempt ${attempt}: ${message}`);
            this.snapshot.restore = {
                attempt,
                offline: this.isOffline(),
                message,
            };
            this.publish();
            // Offline, the network observer starts the next attempt.
            if (!this.isOffline())
                this.restoreTimer = setTimeout(() => {
                    this.restoreTimer = undefined;
                    void this.restoreSession();
                }, restoreRetryDelay(attempt));
        })().finally(() => {
            if (this.restoring === promise) this.restoring = undefined;
        });
        this.restoring = promise;
        return promise;
    }
    private restoreNetworkChanged(state: string): void {
        const restore = this.snapshot.restore;
        if (!restore) return;
        if (state === "offline") {
            if (this.restoreTimer) clearTimeout(this.restoreTimer);
            this.restoreTimer = undefined;
            this.snapshot.restore = { ...restore, offline: true };
            this.publish();
        } else if (state === "online") {
            this.snapshot.restore = { ...restore, offline: false };
            this.publish();
            // Before the SDK reports its initial session, the SDK is restoring
            // on its own; asking now would only wait behind it.
            if (restore.attempt > 0) void this.restoreSession();
        }
    }
    /** Stop restoring: timers, pending attempts and the published state. */
    private endRestore(): void {
        this.restoreRun++;
        if (this.restoreTimer) clearTimeout(this.restoreTimer);
        if (this.slowRestoreTimer) clearTimeout(this.slowRestoreTimer);
        this.restoreTimer = undefined;
        this.slowRestoreTimer = undefined;
        this.restoring = undefined;
        this.snapshot.restore = null;
    }
    /** Retry restoring the saved session now (the "Try again" command). */
    retrySessionRestore(): Promise<void> {
        if (this.disposed || this.snapshot.initialized) return Promise.resolve();
        // Before the first failure, the SDK's own restore is still running.
        if (!this.snapshot.restore?.attempt) return Promise.resolve();
        return this.restoreSession();
    }
    /**
     * Show sign-in instead of waiting for the saved session. The session stays
     * saved: signing in replaces it, and if the SDK restores it first, the
     * account signs in with it as usual.
     */
    abandonSessionRestore(): void {
        if (this.disposed || this.snapshot.initialized) return;
        recordAuthDiagnostic(
            "restore_abandoned",
            `after ${this.snapshot.restore?.attempt ?? 0} failed attempts`,
        );
        this.acceptSession(null);
        this.restoreAbandoned = true;
    }
    /** Recent auth and session-storage events, for error reports. */
    getAuthDiagnostics(): AuthDiagnosticEntry[] {
        return getAuthDiagnostics();
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
    setCloudConsent(accepted: boolean, generation: number): void {
        if (this.disposed || generation !== this.snapshot.generation || !this.snapshot.session) return;
        const profile = this.snapshot.data?.profile;
        if (!profile?.has_ocr_access && !profile?.has_search_index_access) return;
        writeCloudConsent(this.snapshot.session.user.id, accepted);
        this.publish();
    }

    private publishAccess(): void {
        const beaver = Zotero.Beaver;
        if (!beaver) return;
        const profile = this.snapshot.data?.profile;
        const previousSearchAccess = beaver.hasSearchIndexAccess;
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
        const previouslySearchable = beaver.searchableLibraryIds ?? [];
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
        const consent = readCloudConsent(this.snapshot.session?.user.id);
        this.snapshot.cloudConsent = consent;
        const accepted = consent === "accepted";
        if (accepted && (profile?.has_ocr_access || profile?.has_search_index_access)
            && getPref("backgroundProcessingEnabled") !== true) {
            setPref("backgroundProcessingEnabled", true);
        }
        beaver.hasOcrAccess =
            accepted && !!this.snapshot.session && !!profile?.has_ocr_access;
        beaver.hasSearchIndexAccess =
            accepted && !!this.snapshot.session && !!profile?.has_search_index_access;
        beaver.libraryScopeInitialized =
            this.snapshot.scopeReady && !!this.snapshot.session;
        const nowSearchable = new Set(beaver.searchableLibraryIds);
        if (previouslySearchable.some((libraryId) => !nowSearchable.has(libraryId))) {
            beaver.libraryRevocations = (beaver.libraryRevocations ?? 0) + 1;
        }
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
        if (previousSearchAccess !== beaver.hasSearchIndexAccess) {
            beaver.backgroundExtractor?.notify();
        }
    }
    private revoke(): void {
        this.realtime.clear();
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.periodic = false;
        this.lastSuccessAt = 0;
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
        this.rejectionCheckAfter = 0;
        Zotero.Beaver?.voice?.authChanged(null);
        this.publish();
    }
    private acceptSession(session: Session | null): void {
        // However restoring ends (a retry, the SDK's own refresh, or after the
        // user chose to sign in), record that the saved session came back.
        if (session && !this.snapshot.session && !this.pendingAuth) {
            if (!this.snapshot.initialized && this.restoreStarted)
                recordAuthDiagnostic(
                    "restore_succeeded",
                    `after ${this.snapshot.restore?.attempt ?? 0} failed attempts`,
                );
            else if (this.restoreAbandoned)
                recordAuthDiagnostic("restore_succeeded", "after the user chose to sign in");
        }
        if (session) this.restoreAbandoned = false;
        this.endRestore();
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
        // A session this command produces is a sign-in, not a restored one.
        this.restoreAbandoned = false;
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
    private schedule(delay: number, periodic = false): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.periodic = false;
        if (this.disposed || !this.snapshot.session || this.isOffline()) return;
        this.periodic = periodic;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.periodic = false;
            void this.refresh();
        }, delay);
    }
    /** Time until the next periodic refresh is due, given current visibility. */
    private periodicDelay(): number {
        const interval = this.visibleSurfaces.size
            ? VISIBLE_REFRESH_MS
            : HIDDEN_REFRESH_MS;
        return Math.max(0, this.lastSuccessAt + interval - Date.now());
    }
    /**
     * Record whether a renderer is showing Beaver. The periodic refresh runs every
     * 15 minutes while any surface is visible and every 4 hours otherwise; becoming
     * visible with a profile older than 15 minutes refreshes immediately. Renderers
     * must report `false` when they unmount.
     */
    setUIVisible(key: string, visible: boolean): void {
        if (this.disposed) return;
        const wasVisible = this.visibleSurfaces.size > 0;
        if (visible) this.visibleSurfaces.add(key);
        else this.visibleSurfaces.delete(key);
        if (wasVisible === this.visibleSurfaces.size > 0) return;
        // Retries and in-flight reads keep their own schedule; a successful read
        // schedules the next periodic refresh from the current visibility.
        if (this.periodic && this.timer)
            this.schedule(this.periodicDelay(), true);
    }
    private isOffline(): boolean {
        return typeof Services !== "undefined" && Services.io?.offline === true;
    }
    getTransportConfig() {
        return getTransportConfig();
    }

    /** Verify a current caller's rejection without bypassing outage backoff. */
    reportSessionRejected(generation: number): Promise<void> {
        if (this.disposed || generation !== this.snapshot.generation || !this.snapshot.session)
            return Promise.resolve();
        if (this.snapshot.status.kind === "transient" || Date.now() < this.rejectionCheckAfter)
            return this.refreshing?.promise ?? Promise.resolve();
        this.rejectionCheckAfter = Date.now() + 30_000;
        return this.refreshing?.promise ?? this.refresh();
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
        this.periodic = false;
        const generation = this.snapshot.generation;
        const mutation = this.mutationRevision;
        const current = () =>
            !this.disposed && generation === this.snapshot.generation;
        const promise = (async () => {
            try {
                let data = await accountService.getProfileWithPlan({ timeoutMs: 15_000 });
                if (!current()) return;
                if (data.profile.data_version < data.required_data_version) {
                    this.snapshot.migrating = true;
                    this.publish();
                    try {
                        await accountService.migrateData();
                        if (!current()) return;
                        data = await accountService.getProfileWithPlan({ timeoutMs: 15_000 });
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
                this.lastSuccessAt = Date.now();
                this.publish();
                void this.claimPreSyncThreads();
                this.schedule(this.periodicDelay(), true);
            } catch (error) {
                if (!current()) return;
                const e = error as any;
                if (e?.code === "SESSION_EXPIRED" && !this.isOffline()) {
                    void this.auth.signOut();
                    return;
                }
                const transient =
                    (e?.code === "SESSION_EXPIRED" && this.isOffline()) ||
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
                    : isCredentialsBlockedError(error)
                      ? {
                            kind: "fatal",
                            title: CREDENTIALS_BLOCKED_TITLE,
                            message: CREDENTIALS_BLOCKED_MESSAGE,
                            helpUrl: CONNECTION_TROUBLESHOOTING_URL,
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
        this.endRestore();
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
