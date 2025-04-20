import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import LibrarySidebar from './components/LibrarySidebar';
import ReaderSidebar from './components/ReaderSidebar';

// Create a shared store instance
export const store = createStore();

export function renderAiSidebar(domElement: HTMLElement, location: 'library' | 'reader') {
    const root = createRoot(domElement);
    const Component = location === 'library' ? LibrarySidebar : ReaderSidebar;
    
    root.render(
        <Provider store={store}>
            <Component />
        </Provider>
    );
}

export default renderAiSidebar;