import { getLocaleID, getString } from "../utils/locale";
import { triggerToggleChat } from "./toggleChat";
import { initializeReactUI } from "../../react/ui/initialization";
import { KeyboardManager } from "../utils/keyboardManager";
import { getPref } from "../utils/prefs";
import { PreferencePageTab } from "../../react/atoms/ui";

// Create a single instance of keyboard manager
const keyboardManager = new KeyboardManager();

interface BeaverWindow extends Window {
    BeaverReact?: {
        renderAiSidebar: (container: Element, location: string) => any;
        renderGlobalInitializer: (container: Element) => any;
        renderWindowSidebar: (container: Element) => any;
        renderPreferencesWindow: (container: Element, initialTab?: PreferencePageTab | null) => any;
        unmountFromElement: (container: Element) => boolean;
    };
}

// Window name for the separate Beaver window
const BEAVER_WINDOW_NAME = 'beaver-separate-window';

// Window name for the separate Beaver preferences window
const BEAVER_PREFERENCES_WINDOW_NAME = 'beaver-preferences-window';

export class BeaverUIFactory {
    // Store root references per window
    private static windowRoots = new WeakMap<Window, Set<any>>();

    static registerChatPanel(win: BeaverWindow) {
        const windowHref = win.location?.href ?? 'unknown';
        ztoolkit.log(`registerChatPanel: start for window ${windowHref}`);
        // Remove existing panel if present
        this.removeChatPanel(win);
        ztoolkit.log("registerChatPanel: previous panel removed");

        /**
         * Create mounting points for React components
         */
        function createMountingElement(id: string, location: 'library' | 'reader') {
            const mountPoint = win.document.createXULElement("vbox");
            mountPoint.setAttribute("id", id);
            mountPoint.setAttribute("class", "display-flex flex-1 h-full min-w-0");
            mountPoint.setAttribute("style", "min-width: 0px; display: none;");
            
            // Create a div inside the vbox as mount point for the React component
            const reactContainer = win.document.createElement("div");
            reactContainer.setAttribute("id", `beaver-react-root-${location}`);
            reactContainer.setAttribute("data-location", location);
            reactContainer.setAttribute("class", "display-flex flex-1 flex-col h-full min-w-0");
            mountPoint.appendChild(reactContainer);
            
            return { mountPoint, reactContainer };
        }

        // Create and append mounting points
        const itemPane = win.document.getElementById("zotero-item-pane");
        const contextPane = win.document.getElementById("zotero-context-pane");
        ztoolkit.log(`registerChatPanel: itemPane=${Boolean(itemPane)} contextPane=${Boolean(contextPane)} (${windowHref})`);

        if (itemPane) {
            ztoolkit.log("registerChatPanel: creating library mount point");
            const { mountPoint: libraryMount } = createMountingElement("beaver-pane-library", "library");
            itemPane.appendChild(libraryMount);
            ztoolkit.log("registerChatPanel: appended library mount point");
        }

        if (contextPane) {
            ztoolkit.log("registerChatPanel: creating reader mount point");
            const { mountPoint: readerMount } = createMountingElement("beaver-pane-reader", "reader");
            contextPane.appendChild(readerMount);
            ztoolkit.log("registerChatPanel: appended reader mount point");
        }

        // Add toggle button to toolbar
        this.addToolbarButton(win);
        ztoolkit.log("registerChatPanel: toolbar button setup finished");

        // Load React bundle
        const script = win.document.createElement("script");
        script.type = "text/javascript";
        script.src = "chrome://beaver/content/reactBundle.js";
        win.document.documentElement.appendChild(script);
        ztoolkit.log("registerChatPanel: injected reactBundle.js script tag");

        script.onload = () => {
            ztoolkit.log("registerChatPanel: reactBundle.js loaded");
            if (win.BeaverReact && 
                typeof win.BeaverReact.renderAiSidebar === 'function' &&
                typeof win.BeaverReact.renderGlobalInitializer === 'function' &&
                typeof win.BeaverReact.unmountFromElement === 'function') {
                
                ztoolkit.log("registerChatPanel: BeaverReact API verified");
            } else {
                ztoolkit.log("Error: BeaverReact bundle did not load correctly");
            }

            // Initialize React UI
            initializeReactUI(win);
            ztoolkit.log("registerChatPanel: initializeReactUI executed");
            
            // Initialize roots tracking for this window
            if (!this.windowRoots.has(win)) {
                this.windowRoots.set(win, new Set());
            }
            const roots = this.windowRoots.get(win)!;
            
            // Create and render global initializer once
            let globalInitializerRoot = win.document.getElementById("beaver-global-initializer-root");
            if (!globalInitializerRoot) {
                globalInitializerRoot = win.document.createElement("div");
                globalInitializerRoot.id = "beaver-global-initializer-root";
                globalInitializerRoot.style.display = "none";
                win.document.documentElement.appendChild(globalInitializerRoot);
                ztoolkit.log("registerChatPanel: created global initializer root element");
                
                if (typeof win.BeaverReact?.renderGlobalInitializer === 'function') {
                    const root = win.BeaverReact.renderGlobalInitializer(globalInitializerRoot);
                    if (root) roots.add(root);
                    ztoolkit.log("registerChatPanel: renderGlobalInitializer mounted");
                } else {
                    ztoolkit.log("Beaver Error: renderGlobalInitializer function not found on window object.");
                }
            } else {
                ztoolkit.log("registerChatPanel: global initializer root already existed");
            }
            
            // Render React components for actual sidebars
            const libraryRootEl = win.document.getElementById("beaver-react-root-library");
            const readerRootEl = win.document.getElementById("beaver-react-root-reader");
            
            if (libraryRootEl && typeof win.BeaverReact?.renderAiSidebar === 'function') {
                const root = win.BeaverReact.renderAiSidebar(libraryRootEl, "library");
                if (root) roots.add(root);
                ztoolkit.log("registerChatPanel: renderAiSidebar mounted for library");
            }
            if (readerRootEl && typeof win.BeaverReact?.renderAiSidebar === 'function') {
                const root = win.BeaverReact.renderAiSidebar(readerRootEl, "reader");
                if (root) roots.add(root);
                ztoolkit.log("registerChatPanel: renderAiSidebar mounted for reader");
            }
        };
    }

    private static addToolbarButton(win: BeaverWindow) {
        const toolbar = win.document.querySelector("#zotero-tabs-toolbar");
        if (!toolbar) return;

        const key = getPref("keyboardShortcut").toUpperCase() || "J";
        const shortcut = Zotero.isMac ? `⌘${key}` : `Ctrl+${key}`;
        const chatToggleBtn = win.document.createXULElement("toolbarbutton");
        chatToggleBtn.setAttribute("id", "zotero-beaver-tb-chat-toggle");
        chatToggleBtn.setAttribute("tooltiptext", `Toggle Beaver (${shortcut})`);
        chatToggleBtn.addEventListener("command", () => triggerToggleChat(win));

        const syncButton = toolbar.querySelector("#zotero-tb-sync");
        const separator = toolbar.querySelector("div.zotero-tb-separator");

        if (syncButton) {
            toolbar.insertBefore(chatToggleBtn, syncButton);
            if (separator) {
                const clonedSeparator = separator.cloneNode(true) as HTMLElement;
                clonedSeparator.setAttribute("id", "beaver-tb-separator");
                toolbar.insertBefore(clonedSeparator, syncButton);
            }
        } else {
            toolbar.appendChild(chatToggleBtn);
        }
    }

    /**
     * Remove the chat panel and unmount React components.
     * 
     * IMPORTANT: This must always attempt to unmount React components even if
     * win.closed is true, because React cleanup effects need to run to unregister
     * Zotero.Notifier observers. Skipping this causes SIGSEGV during shutdown.
     */
    static removeChatPanel(win: BeaverWindow) {
        ztoolkit.log("BeaverUIFactory.removeChatPanel called.");

        try {
            if (!win) {
                return;
            }

            // Unmount React components - CRITICAL for triggering cleanup effects
            if (win.BeaverReact && typeof win.BeaverReact.unmountFromElement === 'function') {
                const elementIds = ["beaver-react-root-library", "beaver-react-root-reader", "beaver-global-initializer-root"];
                elementIds.forEach(id => {
                    try {
                        const element = win.document?.getElementById?.(id);
                        if (element) {
                            const unmounted = win.BeaverReact!.unmountFromElement(element);
                            if (unmounted) {
                                ztoolkit.log(`Unmounted React component from #${id}`);
                            } else {
                                ztoolkit.log(`No React root found for #${id}`);
                            }
                        }
                    } catch (e: any) {
                        ztoolkit.log(`Error unmounting React component from #${id}: ${e.message}`);
                    }
                });
            }
            
            // Fallback: try to unmount using stored roots
            const roots = this.windowRoots.get(win);
            if (roots && roots.size > 0) {
                roots.forEach(root => {
                    try {
                        root.unmount();
                        ztoolkit.log("Unmounted React root using fallback method");
                    } catch (e: any) {
                        ztoolkit.log(`Error unmounting React root: ${e.message}`);
                    }
                });
                roots.clear();
            }

            this.windowRoots.delete(win);

            // Only try to remove DOM elements if document is still accessible
            if (win.document) {
                try {
                    const elementIds = [
                        "beaver-pane-library", 
                        "beaver-pane-reader", 
                        "zotero-beaver-tb-chat-toggle", 
                        "beaver-tb-separator",
                        "beaver-global-initializer-root"
                    ];
                    elementIds.forEach(id => {
                        try {
                            const element = win.document.getElementById(id);
                            if (element) {
                                element.remove();
                                ztoolkit.log(`Removed element #${id}`);
                            }
                        } catch (e) {
                            // Ignore errors during shutdown
                        }
                    });

                    try {
                        const scriptTag = win.document.querySelector('script[src="chrome://beaver/content/reactBundle.js"]');
                        if (scriptTag) {
                            scriptTag.remove();
                            ztoolkit.log("Removed React bundle script tag.");
                        }
                    } catch (e) {
                        // Ignore errors during shutdown
                    }
                } catch (e) {
                    // Document access failed, ignore
                }
            }
        } catch (error: any) {
            ztoolkit.log(`Error in removeChatPanel: ${error.message}`);
        }
    }

    static registerShortcuts() {
        // Always unregister all existing shortcuts first to prevent duplicates
        keyboardManager.unregisterAll();
        
        if (typeof ztoolkit !== 'undefined') {
            ztoolkit.log("Registering keyboard shortcuts...");
        }

        const keyboardShortcut = getPref("keyboardShortcut").toLowerCase() || "j";

        // Debounce variables for toggle shortcut
        let lastToggleTime = 0;
        const TOGGLE_DEBOUNCE_MS = 200; // 200ms debounce to prevent rapid repeated toggles

        // Register keyboard shortcut for toggling chat panel
        keyboardManager.register(
            (ev, keyOptions) => {
                const isMacToggle = Zotero.isMac && ev.key.toLowerCase() === keyboardShortcut && ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey;
                const isWindowsToggle = !Zotero.isMac && ev.key.toLowerCase() === keyboardShortcut && ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey;
                
                if (isMacToggle || isWindowsToggle) {
                    const now = Date.now();
                    const timeSinceLastToggle = now - lastToggleTime;
                    
                    const timestamp = new Date().toISOString();
                    if (typeof ztoolkit !== 'undefined') {
                        ztoolkit.log(`keyboardManager [${timestamp}]: Keyboard shortcut detected - key: ${ev.key}, metaKey: ${ev.metaKey}, ctrlKey: ${ev.ctrlKey}, shiftKey: ${ev.shiftKey}, altKey: ${ev.altKey}, timeSinceLastToggle: ${timeSinceLastToggle}ms`);
                    }
                    
                    // Debounce: ignore if called too soon after last toggle
                    if (timeSinceLastToggle < TOGGLE_DEBOUNCE_MS) {
                        if (typeof ztoolkit !== 'undefined') {
                            ztoolkit.log(`keyboardManager [${timestamp}]: Toggle ignored (debounced), only ${timeSinceLastToggle}ms since last toggle`);
                        }
                        ev.preventDefault();
                        return;
                    }
                    
                    ev.preventDefault();
                    lastToggleTime = now;
                    
                    let win;
                    if (ev.target && (ev.target as HTMLElement).ownerDocument) {
                        const doc = (ev.target as HTMLElement).ownerDocument;
                        if (doc.defaultView) {
                            win = doc.defaultView;
                        }
                    }
                    
                    if (!win) {
                        win = Zotero.getMainWindow();
                    }
                    
                    triggerToggleChat(win);
                }
            }
        );

        // Register keyboard shortcut for opening separate window
        // Mac: Cmd+Shift+J, Windows/Linux: Ctrl+Shift+J
        keyboardManager.register(
            (ev, keyOptions) => {
                const isMacShortcut = Zotero.isMac && ev.key.toLowerCase() === keyboardShortcut && ev.metaKey && ev.shiftKey && !ev.ctrlKey && !ev.altKey;
                const isWindowsShortcut = !Zotero.isMac && ev.key.toLowerCase() === keyboardShortcut && ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey;
                
                if (isMacShortcut || isWindowsShortcut) {
                    ev.preventDefault();
                    this.openBeaverWindow();
                }
            }
        );
    }
    
    /**
     * Unregister all keyboard shortcuts.
     * 
     * CRITICAL: This must be called during shutdown to:
     * 1. Clear the interval in KeyboardManager
     * 2. Unregister Zotero.Reader event listeners
     */
    static unregisterShortcuts() {
        keyboardManager.unregisterAll();
    }

    /**
     * Find an existing Beaver separate window
     */
    static findBeaverWindow(): Window | undefined {
        try {
            const wm = Services.wm;
            const enumerator = wm.getEnumerator('beaver:window');
            while (enumerator.hasMoreElements()) {
                const win = enumerator.getNext() as Window;
                if (win.name === BEAVER_WINDOW_NAME) {
                    return win;
                }
            }
        } catch (e) {
            // Silently handle errors
        }
        return undefined;
    }

    /**
     * Open Beaver in a separate window
     */
    static openBeaverWindow(): void {
        const existingWindow = this.findBeaverWindow();
        if (existingWindow) {
            existingWindow.focus();
            Zotero.debug("Beaver: Focusing existing separate window");
            return;
        }

        const mainWindow = Zotero.getMainWindow();
        mainWindow.openDialog(
            'chrome://beaver/content/beaverWindow.xhtml',
            BEAVER_WINDOW_NAME,
            'chrome,resizable,centerscreen,dialog=false',
            {}
        );
        Zotero.debug("Beaver: Opened separate window");
    }

    /**
     * Close the Beaver separate window if it exists
     */
    static closeBeaverWindow(): void {
        const existingWindow = this.findBeaverWindow();
        if (existingWindow) {
            existingWindow.close();
            Zotero.debug("Beaver: Closed separate window");
        }
    }

    /**
     * Find an existing Beaver preferences window
     */
    static findPreferencesWindow(): Window | undefined {
        try {
            const wm = Services.wm;
            const enumerator = wm.getEnumerator('beaver:preferences');
            while (enumerator.hasMoreElements()) {
                const win = enumerator.getNext() as Window;
                if (win.name === BEAVER_PREFERENCES_WINDOW_NAME) {
                    return win;
                }
            }
        } catch (e) {
            // Silently handle errors
        }
        return undefined;
    }

    /**
     * Open Beaver preferences in a separate window
     */
    static openPreferencesWindow(tab?: PreferencePageTab): void {
        const existingWindow = this.findPreferencesWindow();
        if (existingWindow) {
            // Switch tab if requested via the global function
            if (tab && (Zotero as any).__beaverOpenPreferencesTab) {
                (Zotero as any).__beaverOpenPreferencesTab(tab);
            }
            existingWindow.focus();
            Zotero.debug("Beaver: Focusing existing preferences window");
            return;
        }

        const mainWindow = Zotero.getMainWindow();
        mainWindow.openDialog(
            'chrome://beaver/content/beaverPreferences.xhtml',
            BEAVER_PREFERENCES_WINDOW_NAME,
            'chrome,resizable,centerscreen,dialog=false',
            { tab: tab || null }
        );
        Zotero.debug("Beaver: Opened preferences window");
    }

    /**
     * Close the Beaver preferences window if it exists
     */
    static closePreferencesWindow(): void {
        const existingWindow = this.findPreferencesWindow();
        if (existingWindow) {
            existingWindow.close();
            Zotero.debug("Beaver: Closed preferences window");
        }
    }
}
