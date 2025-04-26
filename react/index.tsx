import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import LibrarySidebar from './components/LibrarySidebar';
import { useZoteroSync } from './hooks/useZoteroSync';
import { useAuth } from './hooks/useAuth';
import ReaderSidebar from './components/ReaderSidebar';
import { useToggleSidebar } from './hooks/useToggleSidebar';
import { useZoteroTabSelection } from './hooks/useZoteroTabSelection';
import { useAttachmentStatusInfoRow } from './hooks/useAttachmentStatusInfoRow';

// Create a shared store instance
export const store = createStore();

const App = ({ location }: { location: 'library' | 'reader' }) => {

    // Handle Supabase authentication
    useAuth();

    // Handle Zotero sync
    useZoteroSync();

    // Control visibility of the sidebar across app
    useToggleSidebar();
    useZoteroTabSelection();
    useAttachmentStatusInfoRow();

    // Return the sidebar if it is visible and the currently selected tab is a library tab
    return (
        location === 'library' ? <LibrarySidebar /> : <ReaderSidebar />
    );
}

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