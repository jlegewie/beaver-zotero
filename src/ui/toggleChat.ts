/** Toggle the sidebar in the originating main window. */
export function triggerToggleChat(win: Window) {
    if (win.closed || win.__beaverRuntime?.status === 'closing') return;
    const location = win.Zotero_Tabs.selectedType === 'library' ? 'library' : 'reader';
    win.__beaverEventBus?.dispatchEvent(new win.CustomEvent('toggleChat', {
        detail: { location },
    }));
}

/**
 * Toggle the quick prompt — the composer shown in the corner of the main
 * window while the sidebar is closed. The React side decides what the
 * shortcut does when the sidebar is open or Beaver is not signed in.
 */
export function triggerToggleQuickPrompt(win: Window) {
    if (win.closed || win.__beaverRuntime?.status === 'closing') return;
    win.__beaverEventBus?.dispatchEvent(new win.CustomEvent('toggleQuickPrompt', {
        detail: {},
    }));
}
