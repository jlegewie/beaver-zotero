import type { WSAgentActionExecuteRequest } from '@beaver/agent-core/protocol/agentProtocol';
import { ZOTERO_AGENT_NAME, ZOTERO_PLUGIN_CLIENT_TYPE } from '@beaver/agent-core/protocol/agentProtocol';
import { getTransportConfigurationError, setTransportConfig } from '@beaver/agent-core/transport/config';
import { setCredentialAdapter } from '@beaver/agent-core/transport/credentials';
import { setSupabaseClientProvider } from '@beaver/agent-core/transport/supabaseClient';
import { setThreadAgentName } from '@beaver/agent-core/transport/threadService';
import type { ActionCategoryFilter } from '@beaver/agent-core/types/actions';
import { setActionClient } from '@beaver/agent-core/types/actions';
import { Provider } from 'jotai';
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { WindowRuntime } from '../src/runtime/instance';
import { registerTableLocalCommands } from '../src/services/artifacts/tableStore';
import { handleAgentActionExecuteRequest } from '../src/services/agentDataProvider/handleAgentActionExecuteRequest';
import { registerZoteroBusyContext } from '../src/services/busyContext';
import { registerZoteroSyncPause } from '../src/services/syncPause';
import { registerZoteroClientIdentity } from '../src/services/zoteroClientIdentity';
import { createZoteroDataProvider, registerZoteroDataProvider } from '../src/services/zoteroDataProvider';
import { configurePDFForBeaver } from '../src/utils/configurePDFForBeaver';
import { registerZoteroLibraryIdentity } from '../src/utils/libraryIdentity';
import type { AgentAction } from './agents/agentActions';
import { closeWSConnectionForShutdownAtom } from './atoms/agentRunAtoms';
import { buildZoteroApplicationState } from './atoms/applicationState';
import { sessionAtom } from './atoms/auth';
import { isBackgroundWorkerRunningAtom } from './atoms/backgroundExtraction';
import { currentMessageContentAtom, currentReaderAttachmentAtom } from './atoms/messageComposition';
import { preferencesRevisionAtom } from './atoms/preferences';
import { accountGenerationAtom, accountRevisionAtom, isProfileLoadedAtom, profileWithPlanAtom, searchableLibraryIdsAtom } from './atoms/profile';
import { runStatusPopupEnabledAtom } from './atoms/runStatusPopup';
import { isLibraryTabAtom, isSidebarVisibleAtom, PreferencePageTab, selectedZoteroTabIdAtom } from './atoms/ui';
import { currentNoteItemAtom } from './atoms/zoteroContext';
import FloatingPopupRoot from './components/FloatingPopupRoot';
import LibrarySidebar from './components/LibrarySidebar';
import PreferencesWindow from './components/PreferencesWindow';
import ReaderSidebar from './components/ReaderSidebar';
import WindowSidebar from './components/WindowSidebar';
import { eventManager } from './events/eventManager';
import { useAuth } from './hooks/useAuth';
import { useBackgroundProcessingScopeCleanup } from './hooks/useBackgroundProcessingScopeCleanup';
import { useBackgroundProcessingStatus } from './hooks/useBackgroundProcessingStatus';
import { useBackgroundProcessingWelcome } from './hooks/useBackgroundProcessingWelcome';
import { useBackgroundWorkerStatus } from './hooks/useBackgroundWorkerStatus';
import { useContextMenuActionHandler } from './hooks/useContextMenuActionHandler';
import { useEmbeddingIndex } from './hooks/useEmbeddingIndex';
import { useFulltextUpsertLane } from './hooks/useFulltextUpsertLane';
import { useHttpEndpoints } from './hooks/useHttpEndpoints';
import { useInterruptedThreadPopup } from './hooks/useInterruptedThreadPopup';
import { useMcpServer } from './hooks/useMcpServer';
import { useOcrLane } from './hooks/useOcrLane';
import { useOnboardingPopups } from './hooks/useOnboardingPopups';
import { useProfileSync } from './hooks/useProfileSync';
import { useProviderWake } from './hooks/useProviderWake';
import { useReaderAnnotationActionHandler } from './hooks/useReaderAnnotationActionHandler';
import { useReaderSelectionActionHandler } from './hooks/useReaderSelectionActionHandler';
import { useReaderTabSelection } from './hooks/useReaderTabSelection';
import { useReaderVisualizerActionHandler } from './hooks/useReaderVisualizerActionHandler';
import { useRunStatusTip } from './hooks/useRunStatusTip';
import { useSyncSuppression } from './hooks/useSyncSuppression';
import { useThreadProtocolHandler } from './hooks/useThreadProtocolHandler';
import { useToggleSidebar } from './hooks/useToggleSidebar';
import { useUpgradeHandler } from './hooks/useUpgradeHandler';
import { useValidateSyncLibraries } from './hooks/useValidateSyncLibraries';
import { useZoteroContext } from './hooks/useZoteroContext';
import { useZoteroTabSelection } from './hooks/useZoteroTabSelection';
import { registerZoteroHost } from './host/zotero';
import { SurfaceWindowContext } from './runtime/SurfaceWindowContext';
import { attachAccountProjection } from './runtime/accountProjection';
import { openNote, openReader } from './runtime/navigation';
import { captureOperationContext } from './runtime/operationContext';
import { getContextWindow, getWindowRuntime, initializeWindowRuntime } from './runtime/windowRuntime';
import { store } from './store';
import { uiManager } from './ui/UIManager';
import { initializeReactUI } from './ui/initialization';
import { BeaverTemporaryAnnotations } from './utils/annotationUtils';
import { undoEditNoteOrBatchAction } from './utils/editNoteActions';
import { addPopupMessageAtom } from './utils/popupMessageUtils';
import { selectItemById } from './utils/selectItem';
import { notifyWorkerStartFailure } from './utils/workerUnavailableNotice';

// Configure the PDF package (webpack bundle copy). The esbuild bundle
// configures its own copy from `src/hooks.ts`. Both must run because each
// bundle has its own module-scope config in `src/beaver-extract/config.ts`.
// The cross-bundle `MuPDFWorkerClient` per-name singletons are shared via
// `Zotero.__beaverMuPDFWorkerClient_hot` / `_background` regardless.
//
// Only the webpack copy wires `onWorkerStartFailure` to an in-app popup (hot worker only)
configurePDFForBeaver({ onWorkerStartFailure: notifyWorkerStartFailure });

// Register the Zotero client host so rendered chat-history components can
// resolve host-specific navigation and data lookups. Non-Zotero clients omit
// this and run the render surface with the default empty host.
registerZoteroHost();

// Register the Zotero agent data-provider as the default for AgentService and
// ProviderConnection. Must run before either singleton serves its first
// WebSocket data request (both resolve their provider lazily on first use, so
// this only needs to land before that point, not before module load).
registerZoteroDataProvider(options => createZoteroDataProvider({
    ...options,
    operationContext: () => captureOperationContext(options?.source !== "provider"),
}));

// Register the Zotero library-identity resolvers: the object-id resolver used
// by citation and note-reference parsing (citationGrammar.ts) to resolve a
// portable library_ref to this device's local library_id, and the reverse
// lookup that stamps a local library_id with its portable ref. Must run before
// any note or citation is read.
registerZoteroLibraryIdentity();

// Register the Zotero client identity provider used to build the auth
// handshake's frontend_version/client_type/client_features/zotero_instance
// fields. Must run before ProviderConnection opens its first connection.
registerZoteroClientIdentity();

// Declare the client actions are gated on, so a shared action declaring which
// clients it supports is matched against this one. The esbuild bundle registers
// the same value from `src/hooks.ts` for its own copy of that module state.
setActionClient(ZOTERO_PLUGIN_CLIENT_TYPE);

// Scope every thread list to the Zotero agent, matching the agent name the
// backend stamps on threads this client creates. Without it the list would
// also show threads created by the user's other Beaver clients.
setThreadAgentName(ZOTERO_AGENT_NAME);

const instanceAccount = Zotero.Beaver.account;
if (!instanceAccount) throw new Error('Instance account service unavailable');
// Register the backend endpoints. The `process.env` reads live here rather
// than in the transport layer because they only work under a bundler that
// substitutes them at build time; other hosts resolve the same values at
// runtime. Must run before the first backend request or Supabase client use.
setTransportConfig({
    apiBaseUrl: process.env.API_BASE_URL ?? '',
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
}, instanceAccount.getTransportConfig());
setSupabaseClientProvider(() => instanceAccount.client);
setCredentialAdapter({
    auth: instanceAccount.auth,
    getGeneration: () => instanceAccount.getGeneration(),
    reportSessionRejected: generation => { void instanceAccount.reportSessionRejected(generation); },
});

// Register the Zotero busy-context snapshot attached to outgoing WS
// diagnostics, and the sync-pause resume handler released when a mutating
// data request settles. Both are optional niceties (diagnostics, and
// suppressing Zotero's own sync) rather than requirements for a correct
// agent run, but the Zotero plugin always provides them.
registerZoteroBusyContext();
registerZoteroSyncPause();

/**
 * Initializes hooks once per main-window renderer and populates its local store.
 */
const GlobalContextInitializer = () => {
    // Handle Supabase authentication
    useAuth();

    // Handle embedding index
    useEmbeddingIndex();

    // Handle plugin upgrade tasks
    useUpgradeHandler();

    // Handle Zotero sync (legacy cloud processing beta)
    // useZoteroSync();

    // Suppress Zotero auto-sync while mutating agent runs are active.
    useSyncSuppression();

    // Handle Zotero tab selection
    useZoteroTabSelection();

    // Track Zotero application state (selected items, collection, tags, etc.)
    useZoteroContext();

    // Track the active reader tab (open attachment, text selection, new
    // annotations). Global rather than sidebar-mounted so the separate Beaver
    // window gets reader context while the main-window sidebar is closed.
    useReaderTabSelection();

    // Realtime listener for user profile
    useProfileSync();

    // Validate sync libraries against local Zotero (once per session)
    // Also initializes global useLibraryDeletions hook via useValidateSyncLibraries
    useValidateSyncLibraries();

    // Control visibility of the sidebar (e.g., setup global listeners/state)
    useToggleSidebar();

    // Register HTTP endpoints for local FrontendCapability (when authenticated)
    useHttpEndpoints();

    // Register MCP server endpoint (when mcpServerEnabled pref is true)
    useMcpServer();

    // Provider-wake subscription: lets agent runs started from other Beaver
    // clients request library data from this Zotero on demand
    // (when dataProviderEnabled pref is true)
    useProviderWake();

    // Handle zotero://beaver protocol links (thread deep-linking)
    useThreadProtocolHandler();

    // Handle context menu actions dispatched from Zotero 8 MenuManager
    useContextMenuActionHandler();

    // Handle reader text selection actions (Explain / Ask)
    useReaderSelectionActionHandler();

    // Handle reader annotation context menu actions (Explain / Ask)
    useReaderAnnotationActionHandler();

    // Handle dev-only extraction visualizer actions from the reader menu
    useReaderVisualizerActionHandler();

    // Handle first-install and first-reader onboarding popups
    useOnboardingPopups();

    // Offer to reopen a chat that was cut off when Beaver last shut down
    useInterruptedThreadPopup();

    // One-time tip that the corner card follows a run while the sidebar is closed
    useRunStatusTip();

    // Mirror background extraction activity into the shared Jotai store
    useBackgroundWorkerStatus();

    // Publish the searchable-library scope for esbuild background code. Runs
    // before the lane hooks so the mirror is set when a lane first dispatches.


    // Register the OCR background lane + mirror the OCR entitlement flag
    useOcrLane();

    // Mirror the cloud search-index entitlement flag (background-processing plan)


    // Register the authenticated cloud-index lane and reconcile tag coverage.
    useFulltextUpsertLane();

    useBackgroundProcessingWelcome();

    useBackgroundProcessingScopeCleanup();

    // Command readiness follows the subscription effects above, not createRoot().render().
    React.useEffect(() => {
        const runtime = getWindowRuntime();
        if (runtime.status === 'attaching') runtime.status = 'ready';
    }, []);

    return null; // This component does not render any UI
};

// Store root references for proper cleanup
const rootsMap = new Map<HTMLElement, any>();

function mountSurface(domElement: HTMLElement, children: React.ReactNode) {
    unmountFromElement(domElement);
    const root = createRoot(domElement);
    rootsMap.set(domElement, root);
    root.render(
        <Provider store={store}>
            <SurfaceWindowContext.Provider value={domElement.ownerDocument.defaultView}>
                {getTransportConfigurationError() ? (
                    <div role="alert" style={{ padding: 20 }}>
                        <strong>Beaver couldn’t start</strong>
                        <p>{getTransportConfigurationError()}</p>
                        <p>Restart Zotero. If this continues, reinstall Beaver.</p>
                    </div>
                ) : children}
            </SurfaceWindowContext.Provider>
        </Provider>
    );
    return root;
}

/**
 * Renders the GlobalContextInitializer into a dedicated DOM element.
 * This should be called once per window.
 */
export function renderGlobalInitializer(domElement: HTMLElement) {
    return mountSurface(domElement, <GlobalContextInitializer />);
}

const App = ({ location }: { location: 'library' | 'reader' }) => {
    // Return the sidebar based on location
    return (
        location === 'library' ? <LibrarySidebar /> : <ReaderSidebar />
    );
};

export function renderAiSidebar(domElement: HTMLElement, location: 'library' | 'reader') {
    return mountSurface(domElement, <App location={location} />);
}

/**
 * Renders the WindowSidebar into the separate Beaver window.
 * Uses the shared Jotai store for consistent state.
 */
export function renderWindowSidebar(domElement: HTMLElement) {
    return mountSurface(domElement, <WindowSidebar />);
}

/**
 * Renders the floating popup overlay into the main Zotero window.
 * Displays notifications independent of the sidebar (bottom-right corner).
 */
export function renderFloatingPopup(domElement: HTMLElement) {
    return mountSurface(domElement, <FloatingPopupRoot />);
}

/**
 * Renders the PreferencesWindow into the separate preferences window.
 * Uses the shared Jotai store for consistent state.
 */
export function renderPreferencesWindow(domElement: HTMLElement, initialTab?: PreferencePageTab | null, initialActionsCategoryFilter?: ActionCategoryFilter | null, initialActionId?: string | null) {
    return mountSurface(domElement, (
        <PreferencesWindow
            initialTab={initialTab ?? undefined}
            initialActionsCategoryFilter={initialActionsCategoryFilter ?? undefined}
            initialActionId={initialActionId ?? undefined}
        />
    ));
}

/**
 * Unmount a React root from a DOM element
 */
export function unmountFromElement(domElement: HTMLElement) {
    const root = rootsMap.get(domElement);
    if (root) {
        root.unmount();
        rootsMap.delete(domElement);
        return true;
    }
    return false;
}

/**
 * Dev-only cleanup hook called by the esbuild bundle before React unmounts.
 */
export async function cleanupTemporaryAnnotations() {
    if (process.env.NODE_ENV !== 'development') return;
    await BeaverTemporaryAnnotations.cleanupAll();
}

/**
 * Close this window's agent connection. Called synchronously from esbuild
 * shutdown hooks — must not add an await to teardown.
 *
 * `rememberInterruptedThread` records the cut-off thread for the next session
 * to offer. The caller decides — see `onMainWindowUnload`: closing one of
 * several windows leaves Beaver running, so an offer announcing that it closed
 * would be plainly wrong.
 */
export function closeAgentConnection(
    reason: string,
    options?: { rememberInterruptedThread?: boolean },
) {
    store.set(closeWSConnectionForShutdownAtom, reason, options);
}

/** Called by the plugin before mounting any surface. */
export function initializeRuntime(runtime: WindowRuntime) {
    initializeWindowRuntime(runtime);
    Zotero.Beaver.runtime.addWindowCleanup(runtime, registerTableLocalCommands(runtime.hostWindow, runtime.id));
    runtime.hostWindow.__beaverJotaiStore = store;
    if (!getTransportConfigurationError()) attachAccountProjection(runtime);
    Zotero.Beaver.runtime.subscribeWindow(runtime, 'notification:popup', detail => {
        store.set(addPopupMessageAtom, detail);
    });
    initializeReactUI(runtime.hostWindow);
}

export function disposeRuntime() {
    eventManager.dispose();
    for (const root of rootsMap.values()) {
        try { root.unmount(); } catch (error) { Zotero.logError(error as Error); }
    }
    rootsMap.clear();
    uiManager.cleanup();
}

/** Development commands execute inside the target renderer's atom graph. */
export function inspectRuntime(request?: { command?: string; itemId?: number; draft?: string; mutation?: WSAgentActionExecuteRequest; undo?: AgentAction }) {
    if (process.env.NODE_ENV !== 'development') return undefined;
    const runtime = getWindowRuntime();
    switch (request?.command) {
        case 'execute-action':
            if (!request.mutation) return { error: 'mutation_required' };
            return handleAgentActionExecuteRequest({ ...request.mutation, operation: captureOperationContext() }, {
                receivedAt: Date.now(), owner: runtime.id, reportPhase: () => {},
                assertCurrent: () => {
                    if (runtime.status === 'closing') throw Object.assign(new Error('Window closed'), { code: 'window_unavailable' });
                },
            });
        case 'undo-note-action':
            if (!request.undo) return { error: 'action_required' };
            return undoEditNoteOrBatchAction(request.undo).then(() => ({ ok: true }));
        case 'account-state':
            return {
                generation: store.get(accountGenerationAtom), revision: store.get(accountRevisionAtom),
                authenticated: !!store.get(sessionAtom), profileLoaded: store.get(isProfileLoadedAtom),
                identityMatches: store.get(sessionAtom)?.user.id === store.get(profileWithPlanAtom)?.user_id,
                scope: store.get(searchableLibraryIdsAtom), preferencesRevision: store.get(preferencesRevisionAtom),
                runStatusPopupEnabled: store.get(runStatusPopupEnabledAtom),
            };
        case 'open-reader':
            if (request.itemId === undefined) return { error: 'item_required' };
            return openReader(request.itemId).then(reader => ({ itemID: reader?.itemID, targetMatches: reader?._window === runtime.hostWindow }));
        case 'open-note':
            if (request.itemId === undefined) return { error: 'item_required' };
            return openNote(request.itemId).then(editor => ({ itemID: editor?.itemID, tabID: editor?.tabID }));
        case 'context':
            return buildZoteroApplicationState(store.get);
        case 'reveal':
            if (request.itemId === undefined) return { error: 'item_required' };
            return selectItemById(request.itemId, true, undefined, getContextWindow());
        case 'draft':
            if (request.draft !== undefined) store.set(currentMessageContentAtom, request.draft);
            break;
    }
    return {
        id: runtime.id,
        draft: store.get(currentMessageContentAtom),
        visible: store.get(isSidebarVisibleAtom),
        isLibraryTab: store.get(isLibraryTabAtom),
        selectedTabId: store.get(selectedZoteroTabIdAtom),
        hasReaderAttachment: !!store.get(currentReaderAttachmentAtom),
        noteItemId: store.get(currentNoteItemAtom)?.id ?? null,
        backgroundRunning: store.get(isBackgroundWorkerRunningAtom),
        roots: rootsMap.size,
    };
}
