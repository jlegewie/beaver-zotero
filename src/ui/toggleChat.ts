/**
 * Toggle the sidebar in the originating main window. The receiving runtime
 * decides library versus reader presentation from its own context window, so
 * nothing about the tab state is read or sent here.
 */
export function triggerToggleChat(win: Window) {
    if (win.closed || win.__beaverRuntime?.status === 'closing') return;
    win.__beaverEventBus?.dispatchEvent(new win.CustomEvent('toggleChat', {
        detail: {},
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
