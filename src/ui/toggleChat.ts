/** Toggle the sidebar in the originating main window. */
export function triggerToggleChat(win: Window) {
    if (win.closed || win.__beaverRuntime?.status === 'closing') return;
    const location = win.Zotero_Tabs.selectedType === 'library' ? 'library' : 'reader';
    win.__beaverEventBus?.dispatchEvent(new win.CustomEvent('toggleChat', {
        detail: { location },
    }));
}
