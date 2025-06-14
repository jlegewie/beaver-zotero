import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import LibrarySidebar from './components/LibrarySidebar';
import { useZoteroSync } from './hooks/useZoteroSync';
import { useAuth } from './hooks/useAuth';
import ReaderSidebar from './components/ReaderSidebar';
import { useZoteroTabSelection } from './hooks/useZoteroTabSelection';
import { useProfileSync } from './hooks/useProfileSync';
import { useToggleSidebar } from './hooks/useToggleSidebar';
import { useAttachmentStatusInfoRow } from './hooks/useAttachmentStatusInfoRow';

// Create a shared store instance
export const store = createStore();

/**
 * Component to initialize global hooks that should only run once.
 * These hooks will populate the shared Jotai store.
 */
const GlobalContextInitializer = () => {
    // Handle Supabase authentication
    useAuth();

    // Handle Zotero sync
    useZoteroSync();

    // Handle Zotero tab selection
    useZoteroTabSelection();

    // Realtime listener for user profile
    useProfileSync();

    // Control visibility of the sidebar (e.g., setup global listeners/state)
    useToggleSidebar();

    // Handle attachment status info row
    useAttachmentStatusInfoRow();

    return null; // This component does not render any UI
};

/**
 * Renders the GlobalContextInitializer into a dedicated DOM element.
 * This should be called once per window.
 */
export function renderGlobalInitializer(domElement: HTMLElement) {
    const root = createRoot(domElement);
    root.render(
        <Provider store={store}>
            <GlobalContextInitializer />
        </Provider>
    );
}

const App = ({ location }: { location: 'library' | 'reader' }) => {
    // Return the sidebar based on location
    return (
        location === 'library' ? <LibrarySidebar /> : <ReaderSidebar />
    );
};

export function renderAiSidebar(domElement: HTMLElement, location: 'library' | 'reader') {
    const root = createRoot(domElement);

    // Render the component
    root.render(
        <Provider store={store}>
            <App location={location} />
        </Provider>
    );
}

export default renderAiSidebar;