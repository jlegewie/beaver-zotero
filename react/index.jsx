import React from 'react';
import ReactDOM from 'react-dom';
import AiSidebar from './AiSidebar';
import { createRoot } from 'react-dom/client';

export function renderAiSidebar(domElement) {
    // For React 16, we use ReactDOM.render(...)
    // ReactDOM.render(<AiSidebar />, domElement);
    const root = createRoot(domElement);
    root.render(<AiSidebar />);
}

// Unmount the React component
// export function unmountAiSidebar(domElement) {
//   ReactDOM.unmountComponentAtNode(domElement);
// }
