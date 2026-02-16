import React, { useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import FloatingPopupContainer from './ui/popup/FloatingPopupContainer';
import { addFloatingPopupMessageAtom } from '../atoms/floatingPopup';
import { getWindowFromElement } from '../utils/windowContext';

const FloatingPopupRoot: React.FC = () => {
    const containerRef = useRef<HTMLDivElement>(null);
    const addMessage = useSetAtom(addFloatingPopupMessageAtom);

    // Dev-only: keyboard shortcut (Cmd+Shift+9 / Ctrl+Shift+9) and
    // global Zotero.__beaverTestFloatingPopup() for MCP testing.
    useEffect(() => {
        if (process.env.NODE_ENV !== 'development') return;

        const win = getWindowFromElement(containerRef.current);

        const triggerTestPopup = (overrides?: Partial<Record<string, unknown>>) => {
            addMessage({
                type: 'info',
                title: 'Test Floating Popup',
                text: 'This is a test floating popup. It renders in the bottom-right corner independent of the sidebar.',
                expire: true,
                duration: 8000,
                ...overrides,
            });
        };

        // Expose on Zotero global so it can be called via MCP zotero_execute_js:
        //   Zotero.__beaverTestFloatingPopup()
        //   Zotero.__beaverTestFloatingPopup({ type: 'error', title: 'Oops', expire: false })
        (Zotero as any).__beaverTestFloatingPopup = triggerTestPopup;

        const handleKeyDown = (e: KeyboardEvent) => {
            const isShortcut =
                e.key === '9' &&
                e.shiftKey &&
                (Zotero.isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) &&
                !e.altKey;
            if (isShortcut) {
                e.preventDefault();
                triggerTestPopup();
            }
        };

        win.addEventListener('keydown', handleKeyDown);

        return () => {
            win.removeEventListener('keydown', handleKeyDown);
            delete (Zotero as any).__beaverTestFloatingPopup;
        };
    }, [addMessage]);

    return (
        <div ref={containerRef}>
            <FloatingPopupContainer />
        </div>
    );
};

export default FloatingPopupRoot;
