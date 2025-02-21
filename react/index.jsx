import React from 'react';
import App from './App';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';

// jotai store shared between two instances of sidebar
const sharedStore = createStore();

// Export the render function with location identifier
export function renderAiSidebar(domElement, location) {
    const root = createRoot(domElement);
    root.render(
        <Provider store={sharedStore}>
            <App location={location} />
        </Provider>
    );
}