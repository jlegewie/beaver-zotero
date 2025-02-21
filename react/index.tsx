import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'jotai';
import LibrarySidebar from './components/LibrarySidebar';
import ReaderSidebar from './components/ReaderSidebar';

export function renderAiSidebar(domElement: HTMLElement, location: 'library' | 'reader') {
    const root = createRoot(domElement);
    const Component = location === 'library' ? LibrarySidebar : ReaderSidebar;
    
    root.render(
        <Provider>
            <Component />
        </Provider>
    );
}

export default renderAiSidebar;