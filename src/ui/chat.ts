
/**
* Toggle the chat panel on and off.
* 
* @param win - The window to toggle the chat in.
* @param turnOn - Whether to turn the chat on or off.
*/
export function toggleChat(win: Window, turnOn: boolean) {
    const itemPane = win.document.querySelector("item-pane#zotero-item-pane");
    const deck = itemPane?.querySelector("#zotero-item-pane-content");
    const sidenav = itemPane?.querySelector("#zotero-view-item-sidenav");
    const chat = itemPane?.querySelector("#zotero-beaver-chat");
    if (!itemPane || !deck || !sidenav || !chat) return;
    
    if (turnOn) {
        // 1) Remember current "collapsed" status of the right pane
        const wasCollapsed = itemPane.getAttribute("collapsed") === "true";
        // @ts-ignore zotero item-pane is not typed
        itemPane.dataset.beaverWasCollapsed = wasCollapsed ? "true" : "false";
        
        // 2) If it was collapsed, open it
        if (wasCollapsed) {
            itemPane.removeAttribute("collapsed");
        }
        
        // 3) Hide the deck and sidenav
        // @ts-ignore zotero item-pane is not typed
        deck.hidden = true;
        // @ts-ignore zotero item-pane is not typed
        sidenav.hidden = true;
        // 4) Show chat
        // @ts-ignore zotero item-pane is not typed
        chat.hidden = false;
        // 5) Mark that chat is active
        // @ts-ignore zotero item-pane is not typed
        itemPane.dataset.beaverChatActive = "true";

        const chatToggleBtn = win.document.querySelector("#zotero-beaver-tb-chat-toggle");
        if (chatToggleBtn) {
            chatToggleBtn.setAttribute("selected", "true");
        }
    }
    else {
        // Turn chat off
        
        // Hide chat
        // @ts-ignore zotero item-pane is not typed
        chat.hidden = true;
        // @ts-ignore zotero item-pane is not typed
        itemPane.dataset.beaverChatActive = "false";
        
        // Check if the right pane was collapsed before
        // @ts-ignore zotero item-pane is not typed
        const wasCollapsed = itemPane.dataset.beaverWasCollapsed === "true";
        if (wasCollapsed) {
            // Re-collapse the pane
            itemPane.setAttribute("collapsed", "true");
        }
        // else {
            // Show the normal deck/sidenav
            // @ts-ignore zotero item-pane is not typed
            deck.hidden = false;
            // @ts-ignore zotero item-pane is not typed
            sidenav.hidden = false;
        // }
        const chatToggleBtn = win.document.querySelector("#zotero-beaver-tb-chat-toggle");
        if (chatToggleBtn) {
            chatToggleBtn.removeAttribute("selected");
        }
    }
}

/**
* Watch the item pane for changes to the sidenav and hide it if the chat is active.
* 
* @param win - The window to watch.
*/
export function watchPane(win: Window) {
    const itemPane = win.document.querySelector("item-pane#zotero-item-pane");
    if (!itemPane) return;
    
    const sidenav = itemPane.querySelector("#zotero-view-item-sidenav");
    if (!sidenav) return;
    
    // Observe attribute changes on sidenav
    const observer = new win.MutationObserver((mutations: MutationRecord[]) => {
        for (const m of mutations) {
            if (m.type === "attributes" && m.attributeName === "hidden") {
                ztoolkit.log("Sidenav hidden");
                // @ts-ignore zotero item-pane is not typed
                const chatActive = (itemPane.dataset.beaverChatActive === "true");
                // If chat is active but Zotero just unhid the sidenav, force it hidden
                // @ts-ignore zotero item-pane is not typed
                if (chatActive && sidenav.hidden === false) {
                    // @ts-ignore zotero item-pane is not typed
                    sidenav.hidden = true;
                }
            }
        }
    });
    
    observer.observe(sidenav, { attributes: true });
}

/**
* Watch the item pane for changes to the collapsed attribute and close the chat if the item pane is collapsed.
* 
* @param win - The window to watch.
*/
export function watchItemPaneCollapse(win: Window) {
    const itemPane = win.document.querySelector("item-pane#zotero-item-pane");
    const chat = itemPane?.querySelector("#zotero-beaver-chat");
    if (!itemPane || !chat) return;
    
    const observer = new win.MutationObserver((mutations: MutationRecord[]) => {
        for (const m of mutations) {
            if (m.type === "attributes" && m.attributeName === "collapsed") {
                const isCollapsed = itemPane.getAttribute("collapsed") === "true";
                // @ts-ignore zotero item-pane is not typed
                const chatActive = itemPane.dataset.beaverChatActive === "true";
                
                if (isCollapsed && chatActive) {
                    // If user collapses while chat is open, close chat
                    toggleChat(win, false);
                }
            }
        }
    });
    
    observer.observe(itemPane, { attributes: true });
}

export function unwatchPane(win: Window) {
    const itemPane = win.document.querySelector("item-pane#zotero-item-pane");
    if (!itemPane) return;
    
    const observer = win.MutationObserver;
    observer.disconnect();
}

export function unwatchItemPaneCollapse(win: Window) {
    const itemPane = win.document.querySelector("item-pane#zotero-item-pane");
    if (!itemPane) return;
    
    const observer = win.MutationObserver;
    observer.disconnect();
}