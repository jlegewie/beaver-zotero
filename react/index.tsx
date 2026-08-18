import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'jotai';
import { configurePDFForBeaver } from '../src/utils/configurePDFForBeaver';
import LibrarySidebar from './components/LibrarySidebar';
import { useZoteroSync } from './hooks/useZoteroSync';
import { useEmbeddingIndex } from './hooks/useEmbeddingIndex';
import { useAuth } from './hooks/useAuth';
import ReaderSidebar from './components/ReaderSidebar';
import WindowSidebar from './components/WindowSidebar';
import FloatingPopupRoot from './components/FloatingPopupRoot';
import PreferencesWindow from './components/PreferencesWindow';
import { PreferencePageTab } from './atoms/ui';
import type { ActionCategoryFilter } from '@beaver/agent-core/types/actions';
import { useZoteroTabSelection } from './hooks/useZoteroTabSelection';
import { useZoteroContext } from './hooks/useZoteroContext';
import { useReaderTabSelection } from './hooks/useReaderTabSelection';
import { useProfileSync } from './hooks/useProfileSync';
import { useToggleSidebar } from './hooks/useToggleSidebar';
import { store } from './store';
import { useValidateSyncLibraries } from './hooks/useValidateSyncLibraries';
import { useUpgradeHandler } from './hooks/useUpgradeHandler';
import { useHttpEndpoints } from './hooks/useHttpEndpoints';
import { useMcpServer } from './hooks/useMcpServer';
import { useProviderWake } from './hooks/useProviderWake';
import { useThreadProtocolHandler } from './hooks/useThreadProtocolHandler';
import { useContextMenuActionHandler } from './hooks/useContextMenuActionHandler';
import { useReaderSelectionActionHandler } from './hooks/useReaderSelectionActionHandler';
import { useReaderAnnotationActionHandler } from './hooks/useReaderAnnotationActionHandler';
import { useReaderVisualizerActionHandler } from './hooks/useReaderVisualizerActionHandler';
import { useOnboardingPopups } from './hooks/useOnboardingPopups';
import { useBackgroundWorkerStatus } from './hooks/useBackgroundWorkerStatus';
import { useLibraryScopeMirror } from './hooks/useLibraryScopeMirror';
import { useOcrLane } from './hooks/useOcrLane';
import { useSearchIndexAccess } from './hooks/useSearchIndexAccess';
import { useFulltextUpsertLane } from './hooks/useFulltextUpsertLane';
import { useBackgroundProcessingStatus } from './hooks/useBackgroundProcessingStatus';
import { useBackgroundProcessingWelcome } from './hooks/useBackgroundProcessingWelcome';
import { useBackgroundProcessingScopeCleanup } from './hooks/useBackgroundProcessingScopeCleanup';
import { useSyncSuppression } from './hooks/useSyncSuppression';
import { BeaverTemporaryAnnotations } from './utils/annotationUtils';
import { setTransportConfig } from '@beaver/agent-core/transport/config';
import { registerZoteroHost } from './host/zotero';
import { registerZoteroDataProvider } from '../src/services/zoteroDataProvider';
import { registerZoteroLibraryIdentity } from '../src/utils/libraryIdentity';
import { registerZoteroClientIdentity } from '../src/services/zoteroClientIdentity';
import { setThreadAgentName } from '@beaver/agent-core/transport/threadService';
import { setActionClient } from '@beaver/agent-core/types/actions';
import { ZOTERO_AGENT_NAME, ZOTERO_PLUGIN_CLIENT_TYPE } from '@beaver/agent-core/protocol/agentProtocol';
import { registerZoteroSupabaseStorage, registerZoteroSupabaseReloadBridge } from '../src/services/zoteroSupabaseStorage';
import { setSupabaseAuthPolicy } from '@beaver/agent-core/transport/supabaseClient';
import { registerZoteroBusyContext } from '../src/services/busyContext';
import { registerZoteroSyncPause } from '../src/services/syncPause';
import { notifyWorkerStartFailure } from './utils/workerUnavailableNotice';

// Configure the PDF package (webpack bundle copy). The esbuild bundle
// configures its own copy from `src/hooks.ts`. Both must run because each
// bundle has its own module-scope config in `src/beaver-extract/config.ts`.
// The cross-bundle `MuPDFWorkerClient` per-name singletons are shared via
// `Zotero.__beaverMuPDFWorkerClient_hot` / `_background` regardless.
//
// Only the webpack copy wires `onWorkerStartFailure` to an in-app popup (hot worker only)
configurePDFForBeaver({ onWorkerStartFailure: notifyWorkerStartFailure });

// Register the backend endpoints. The `process.env` reads live here rather
// than in the transport layer because they only work under a bundler that
// substitutes them at build time; other hosts resolve the same values at
// runtime. Must run before the first backend request or Supabase client use.
setTransportConfig({
    apiBaseUrl: process.env.API_BASE_URL ?? '',
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
});

// Register the Zotero client host so rendered chat-history components can
// resolve host-specific navigation and data lookups. Non-Zotero clients omit
// this and run the render surface with the default empty host.
registerZoteroHost();

// Register the Zotero agent data-provider as the default for AgentService and
// ProviderConnection. Must run before either singleton serves its first
// WebSocket data request (both resolve their provider lazily on first use, so
// this only needs to land before that point, not before module load).
registerZoteroDataProvider();

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

// Register the Zotero encrypted-storage adapter the Supabase auth session
// persists into. Must run before the exported `supabase` client is first
// used (the client is created lazily on first property access).
registerZoteroSupabaseStorage();

// Zotero runs a single window that may sit obscured for long stretches while
// its session must stay alive, so the auth client refreshes on its own ticker
// rather than only while the window is visible. Must run before the client is
// first used; this restates the default explicitly.
setSupabaseAuthPolicy({ forceAutoRefresh: true });

// Register the window-scoped bridge to Supabase state that survives a plugin
// reload. Registering is what stops a previous bundle instance's auto-refresh
// ticker (two tickers race for the single-use refresh token) and adopts its
// auth lock, so it must run before the client is first used.
registerZoteroSupabaseReloadBridge();

// Register the Zotero busy-context snapshot attached to outgoing WS
// diagnostics, and the sync-pause resume handler released when a mutating
// data request settles. Both are optional niceties (diagnostics, and
// suppressing Zotero's own sync) rather than requirements for a correct
// agent run, but the Zotero plugin always provides them.
registerZoteroBusyContext();
registerZoteroSyncPause();

/**
 * Component to initialize global hooks that should only run once.
 * These hooks will populate the shared Jotai store.
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

    // Mirror background extraction activity into the shared Jotai store
    useBackgroundWorkerStatus();

    // Publish the searchable-library scope for esbuild background code. Runs
    // before the lane hooks so the mirror is set when a lane first dispatches.
    useLibraryScopeMirror();

    // Register the OCR background lane + mirror the OCR entitlement flag
    useOcrLane();

    // Mirror the cloud search-index entitlement flag (background-processing plan)
    useSearchIndexAccess();

    // Register the authenticated cloud-index lane and reconcile tag coverage.
    useFulltextUpsertLane();

    // Poll queue, ledger, and remote coverage for status UI.
    useBackgroundProcessingStatus({
        onlyWhenEnabled: true,
        pollIntervalMs: 15_000,
    });

    useBackgroundProcessingWelcome();

    useBackgroundProcessingScopeCleanup();

    return null; // This component does not render any UI
};

// Store root references for proper cleanup
const rootsMap = new Map<HTMLElement, any>();

/**
 * Renders the GlobalContextInitializer into a dedicated DOM element.
 * This should be called once per window.
 */
export function renderGlobalInitializer(domElement: HTMLElement) {
    // Clean up any existing root first
    const existingRoot = rootsMap.get(domElement);
    if (existingRoot) {
        existingRoot.unmount();
        rootsMap.delete(domElement);
    }

    const root = createRoot(domElement);
    rootsMap.set(domElement, root);
    
    root.render(
        <Provider store={store}>
            <GlobalContextInitializer />
        </Provider>
    );
    
    return root;
}

const App = ({ location }: { location: 'library' | 'reader' }) => {
    // Return the sidebar based on location
    return (
        location === 'library' ? <LibrarySidebar /> : <ReaderSidebar />
    );
};

export function renderAiSidebar(domElement: HTMLElement, location: 'library' | 'reader') {
    // Clean up any existing root first
    const existingRoot = rootsMap.get(domElement);
    if (existingRoot) {
        existingRoot.unmount();
        rootsMap.delete(domElement);
    }

    const root = createRoot(domElement);
    rootsMap.set(domElement, root);

    // Render the component
    root.render(
        <Provider store={store}>
            <App location={location} />
        </Provider>
    );
    
    return root;
}

/**
 * Renders the WindowSidebar into the separate Beaver window.
 * Uses the shared Jotai store for consistent state.
 */
export function renderWindowSidebar(domElement: HTMLElement) {
    // Clean up any existing root first
    const existingRoot = rootsMap.get(domElement);
    if (existingRoot) {
        existingRoot.unmount();
        rootsMap.delete(domElement);
    }

    const root = createRoot(domElement);
    rootsMap.set(domElement, root);

    root.render(
        <Provider store={store}>
            <WindowSidebar />
        </Provider>
    );

    return root;
}

/**
 * Renders the floating popup overlay into the main Zotero window.
 * Displays notifications independent of the sidebar (bottom-right corner).
 */
export function renderFloatingPopup(domElement: HTMLElement) {
    // Clean up any existing root first
    const existingRoot = rootsMap.get(domElement);
    if (existingRoot) {
        existingRoot.unmount();
        rootsMap.delete(domElement);
    }

    const root = createRoot(domElement);
    rootsMap.set(domElement, root);

    root.render(
        <Provider store={store}>
            <FloatingPopupRoot />
        </Provider>
    );

    return root;
}

/**
 * Renders the PreferencesWindow into the separate preferences window.
 * Uses the shared Jotai store for consistent state.
 */
export function renderPreferencesWindow(domElement: HTMLElement, initialTab?: PreferencePageTab | null, initialActionsCategoryFilter?: ActionCategoryFilter | null, initialActionId?: string | null) {
    // Clean up any existing root first
    const existingRoot = rootsMap.get(domElement);
    if (existingRoot) {
        existingRoot.unmount();
        rootsMap.delete(domElement);
    }

    const root = createRoot(domElement);
    rootsMap.set(domElement, root);

    root.render(
        <Provider store={store}>
            <PreferencesWindow
                initialTab={initialTab ?? undefined}
                initialActionsCategoryFilter={initialActionsCategoryFilter ?? undefined}
                initialActionId={initialActionId ?? undefined}
            />
        </Provider>
    );

    return root;
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
