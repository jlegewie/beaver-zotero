import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'jotai';
import LibrarySidebar from './components/LibrarySidebar';
import { useZoteroSync } from './hooks/useZoteroSync';
import { useAuth } from './hooks/useAuth';
import ReaderSidebar from './components/ReaderSidebar';
import WindowSidebar from './components/WindowSidebar';
import { useZoteroTabSelection } from './hooks/useZoteroTabSelection';
import { useProfileSync } from './hooks/useProfileSync';
import { useToggleSidebar } from './hooks/useToggleSidebar';
import { store } from './store';
import { useValidateSyncLibraries } from './hooks/useValidateSyncLibraries';
import { useUpgradeHandler } from './hooks/useUpgradeHandler';


/**
 * Component to initialize global hooks that should only run once.
 * These hooks will populate the shared Jotai store.
 */
const GlobalContextInitializer = () => {
    // Handle Supabase authentication
    useAuth();

    // Handle plugin upgrade tasks
    useUpgradeHandler();

    // Handle Zotero sync
    useZoteroSync();

    // Handle Zotero tab selection
    useZoteroTabSelection();

    // Realtime listener for user profile
    useProfileSync();

    // Validate sync libraries against local Zotero (once per session)
    // Also initializes global useLibraryDeletions hook via useValidateSyncLibraries
    useValidateSyncLibraries();

    // Control visibility of the sidebar (e.g., setup global listeners/state)
    useToggleSidebar();

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