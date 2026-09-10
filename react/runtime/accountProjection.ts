import { threadNavigationSeqAtom, recentThreadsAtom } from "../atoms/threads";
import { preferencesRevisionAtom } from "../atoms/preferences";
import {
    refreshCustomModelsAtom,
    resetUserModelStateAtom,
    googleApiKeyAtom,
    openAiApiKeyAtom,
    anthropicApiKeyAtom,
} from "../atoms/models";
import { getPref } from "../../src/utils/prefs";
import type { WindowRuntime } from "../../src/runtime/instance";
import { store } from "../store";
import {
    sessionAtom,
    authLoadingAtom,
    loginLoadingAtom,
    resetLoginFormState,
    isWaitingForProfileAtom,
} from "../atoms/auth";
import {
    accountGenerationAtom,
    accountRevisionAtom,
    profileProjectionAtom,
    isProfileLoadedAtom,
    profileSyncStatusAtom,
    localZoteroLibrariesAtom,
    localZoteroLibrariesInitializedAtom,
    isMigratingDataAtom,
    requiredDataVersionAtom,
    minimumFrontendVersionAtom,
} from "../atoms/profile";
import { setModelsAtom } from "../atoms/models";
import { resetThreadStoreAtom } from "../atoms/threadList";
import {
    clearThreadAtom,
    abandonActiveRunLocallyAtom,
} from "../atoms/agentRunAtoms";
import {
    clearComposerAtom,
    clearMessageContextAtom,
} from "../atoms/messageComposition";
import { agentService } from "@beaver/agent-core/transport/agentService";
import { providerConnection } from "@beaver/agent-core/transport/providerConnection";
import {
    firstRunNextStepsDismissedAtom,
    firstRunReturnRequestedAtom,
    firstRunSuggestionsAtom,
    firstRunSuggestionsErrorAtom,
    firstRunSuggestionsLoadingAtom,
    firstRunSuggestionsModeAtom,
} from "../atoms/firstRun";
import { whereToStartVisibleAtom } from "../atoms/whereToStart";

/** Hydrate before mounting and synchronously revoke account-scoped UI state. */
export function attachAccountProjection(runtime: WindowRuntime): void {
    const account = Zotero.Beaver.account;
    if (!account) throw new Error("Instance account service unavailable");
    const preferences = Zotero.Beaver.preferences;
    if (preferences) {
        const remove = preferences.subscribe((change) => {
            store.set(preferencesRevisionAtom, change.revision);
            if (change.key === "customChatModels")
                store.set(refreshCustomModelsAtom);
            if (change.key === "googleGenerativeAiApiKey")
                store.set(
                    googleApiKeyAtom,
                    getPref("googleGenerativeAiApiKey") || "",
                );
            if (change.key === "openAiApiKey")
                store.set(openAiApiKeyAtom, getPref("openAiApiKey") || "");
            if (change.key === "anthropicApiKey")
                store.set(
                    anthropicApiKeyAtom,
                    getPref("anthropicApiKey") || "",
                );
        });
        store.set(preferencesRevisionAtom, preferences.getSnapshot().revision);
        Zotero.Beaver.runtime.addWindowCleanup(runtime, remove);
    }
    let generation = -1;
    let revision = -1;
    let modelsKey = "";
    let keysGeneration = -1;
    let previousScope: number[] = [];
    const unsubscribe = account.subscribe((snapshot) => {
        if (
            runtime.status === "closing" ||
            snapshot.revision <= revision ||
            snapshot.generation < generation
        )
            return;
        const scope = Zotero.Beaver.searchableLibraryIds ?? [];
        if (previousScope.some((id) => !scope.includes(id))) {
            agentService.close(1000, "Library access changed");
            providerConnection.close(1000, "Library access changed");
            store.set(abandonActiveRunLocallyAtom);
        }
        previousScope = [...scope];
        if (generation !== snapshot.generation) {
            modelsKey = "";
            agentService.close(1000, "Account changed");
            providerConnection.close(1000, "Account changed");
            store.set(abandonActiveRunLocallyAtom);
            store.set(threadNavigationSeqAtom, (value) => value + 1);
            store.set(recentThreadsAtom, []);
            store.set(clearThreadAtom);
            store.set(resetThreadStoreAtom);
            if (generation !== -1) store.set(resetUserModelStateAtom);
            store.set(clearComposerAtom);
            store.set(clearMessageContextAtom);
            // A signed-out verification attempt revokes pending credentials too,
            // but its OTP step/countdown must survive a failed attempt.
            if (!snapshot.authenticating || store.get(sessionAtom))
                resetLoginFormState(store.set);
            store.set(firstRunNextStepsDismissedAtom, new Set());
            store.set(firstRunReturnRequestedAtom, false);
            store.set(firstRunSuggestionsModeAtom, false);
            store.set(firstRunSuggestionsAtom, null);
            store.set(firstRunSuggestionsErrorAtom, null);
            store.set(firstRunSuggestionsLoadingAtom, false);
            store.set(whereToStartVisibleAtom, false);
        }
        generation = snapshot.generation;
        revision = snapshot.revision;
        store.set(accountGenerationAtom, generation);
        store.set(accountRevisionAtom, revision);
        store.set(profileProjectionAtom, snapshot.data?.profile ?? null);
        store.set(localZoteroLibrariesAtom, snapshot.libraries);
        store.set(localZoteroLibrariesInitializedAtom, snapshot.scopeReady);
        store.set(isProfileLoadedAtom, !!snapshot.data);
        store.set(profileSyncStatusAtom, snapshot.status);
        store.set(isMigratingDataAtom, snapshot.migrating);
        store.set(
            requiredDataVersionAtom,
            snapshot.data?.required_data_version ?? 0,
        );
        store.set(
            minimumFrontendVersionAtom,
            snapshot.data?.minimum_frontend_version ?? null,
        );
        // Session acceptance follows account-specific preference cleanup. Rehydrate
        // even when saved keys did not change and no preference event was emitted.
        if (snapshot.session && keysGeneration !== generation) {
            store.set(
                googleApiKeyAtom,
                getPref("googleGenerativeAiApiKey") || "",
            );
            store.set(openAiApiKeyAtom, getPref("openAiApiKey") || "");
            store.set(anthropicApiKeyAtom, getPref("anthropicApiKey") || "");
            keysGeneration = generation;
        }
        if (snapshot.data) {
            const key = JSON.stringify(snapshot.data.model_configs);
            if (key !== modelsKey) {
                modelsKey = key;
                store.set(setModelsAtom, snapshot.data.model_configs);
            }
            store.set(isWaitingForProfileAtom, false);
        }
        store.set(sessionAtom, snapshot.session);
        store.set(authLoadingAtom, !snapshot.initialized);
        store.set(loginLoadingAtom, snapshot.authenticating);
    });
    Zotero.Beaver.runtime.addWindowCleanup(runtime, unsubscribe);
}
