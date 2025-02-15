import React from 'react';
import ReactDOM from 'react-dom';
import ChatApp from './ChatApp';

export function renderChatApp(domElement) {
    // For React 16, we use ReactDOM.render(...)
    ReactDOM.render(<ChatApp />, domElement);
}

// Unmount the React component
// export function unmountChatApp(domElement) {
//   ReactDOM.unmountComponentAtNode(domElement);
// }
