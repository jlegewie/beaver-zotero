import React from 'react';
import ReactDOM from 'react-dom';
import ChatApp from './ChatApp';
import { createRoot } from 'react-dom/client';

export function renderChatApp(domElement) {
    // For React 16, we use ReactDOM.render(...)
    // ReactDOM.render(<ChatApp />, domElement);
    const root = createRoot(domElement);
    root.render(<ChatApp />);
}

// Unmount the React component
// export function unmountChatApp(domElement) {
//   ReactDOM.unmountComponentAtNode(domElement);
// }
