import { getLocaleID, getString } from "../utils/locale";
import { triggerToggleChat } from "./toggleChat";
import { initializeReactUI } from "../../react/ui/initialization";
import { KeyboardManager } from "../utils/keyboardManager";
import { getPref } from "../utils/prefs";

// Create a single instance of keyboard manager
const keyboardManager = new KeyboardManager();

interface BeaverWindow extends Window {
    BeaverReact?: {
        renderAiSidebar: (container: Element, location: string) => any;
        renderGlobalInitializer: (container: Element) => any;
        unmountFromElement: (container: Element) => boolean;
    };
}

export class BeaverUIFactory {
    // Store root references per window
    private static windowRoots = new WeakMap<Window, Set<any>>();

    static registerChatPanel(win: BeaverWindow) {
        // Remove existing panel if present
        this.removeChatPanel(win);

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

        if (itemPane) {
            const { mountPoint: libraryMount } = createMountingElement("beaver-pane-library", "library");
            itemPane.appendChild(libraryMount);
        }

        if (contextPane) {
            const { mountPoint: readerMount } = createMountingElement("beaver-pane-reader", "reader");
            contextPane.appendChild(readerMount);
        }

        // Add toggle button to toolbar
        this.addToolbarButton(win);

        // Load React bundle
        const script = win.document.createElement("script");
        script.type = "text/javascript";
        script.src = "chrome://beaver/content/reactBundle.js";
        win.document.documentElement.appendChild(script);

        script.onload = () => {
            if (win.BeaverReact && 
                typeof win.BeaverReact.renderAiSidebar === 'function' &&
                typeof win.BeaverReact.renderGlobalInitializer === 'function' &&
                typeof win.BeaverReact.unmountFromElement === 'function') {
                
                // All functions verified, proceed with mounting
            } else {
                ztoolkit.log("Error: BeaverReact bundle did not load correctly");
            }

            // Initialize React UI
            initializeReactUI(win);
            
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
                
                if (typeof win.BeaverReact?.renderGlobalInitializer === 'function') {
                    const root = win.BeaverReact.renderGlobalInitializer(globalInitializerRoot);
                    if (root) roots.add(root);
                } else {
                    ztoolkit.log("Beaver Error: renderGlobalInitializer function not found on window object.");
                }
            }
            
            // Render React components for actual sidebars
            const libraryRootEl = win.document.getElementById("beaver-react-root-library");
            const readerRootEl = win.document.getElementById("beaver-react-root-reader");
            
            if (libraryRootEl && typeof win.BeaverReact?.renderAiSidebar === 'function') {
                const root = win.BeaverReact.renderAiSidebar(libraryRootEl, "library");
                if (root) roots.add(root);
            }
            if (readerRootEl && typeof win.BeaverReact?.renderAiSidebar === 'function') {
                const root = win.BeaverReact.renderAiSidebar(readerRootEl, "reader");
                if (root) roots.add(root);
            }
        };
    }

    private static addToolbarButton(win: BeaverWindow) {
        const toolbar = win.document.querySelector("#zotero-tabs-toolbar");
        if (!toolbar) return;

        const key = getPref("keyboardShortcut").toUpperCase() || "L";
        const shortcut = Zotero.isMac ? `⌘${key}` : `Ctrl+${key}`;
        const chatToggleBtn = win.document.createXULElement("toolbarbutton");
        chatToggleBtn.setAttribute("id", "zotero-beaver-tb-chat-toggle");
        chatToggleBtn.setAttribute("tooltiptext", `Toggle AI Chat (${shortcut})`);
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

    static removeChatPanel(win: BeaverWindow) {
        ztoolkit.log("[Beaver] BeaverUIFactory.removeChatPanel called.");

        // Unmount React components using the correct API
        if (win.BeaverReact && typeof win.BeaverReact.unmountFromElement === 'function') {
            const elementIds = ["beaver-react-root-library", "beaver-react-root-reader", "beaver-global-initializer-root"];
            elementIds.forEach(id => {
                const element = win.document.getElementById(id);
                if (element) {
                    try {
                        const unmounted = win.BeaverReact!.unmountFromElement(element);
                        if (unmounted) {
                            ztoolkit.log(`[Beaver] Unmounted React component from #${id}`);
                        } else {
                            ztoolkit.log(`[Beaver] No React root found for #${id}`);
                        }
                    } catch (e: any) {
                        ztoolkit.log(`[Beaver] Error unmounting React component from #${id}: ${e.message}`);
                    }
                }
            });
        } else {
            // Fallback: unmount all roots for this window
            const roots = this.windowRoots.get(win);
            if (roots) {
                roots.forEach(root => {
                    try {
                        root.unmount();
                        ztoolkit.log("[Beaver] Unmounted React root using fallback method");
                    } catch (e: any) {
                        ztoolkit.log(`[Beaver] Error unmounting React root: ${e.message}`);
                    }
                });
                roots.clear();
            }
            ztoolkit.log("[Beaver] unmountFromElement function not available on window object during cleanup.");
        }

        // Clean up roots tracking
        this.windowRoots.delete(win);

        // Remove DOM elements
        const elementIds = [
            "beaver-pane-library", 
            "beaver-pane-reader", 
            "zotero-beaver-tb-chat-toggle", 
            "beaver-tb-separator",
            "beaver-global-initializer-root"
        ];
        elementIds.forEach(id => {
            const element = win.document.getElementById(id);
            if (element) {
                element.remove();
                ztoolkit.log(`[Beaver] Removed element #${id}`);
            }
        });

        // Remove the React bundle script tag
        const scriptTag = win.document.querySelector('script[src="chrome://beaver/content/reactBundle.js"]');
        if (scriptTag) {
            scriptTag.remove();
            ztoolkit.log("[Beaver] Removed React bundle script tag.");
        }
    }

    static registerShortcuts() {
        // Always unregister all existing shortcuts first to prevent duplicates
        keyboardManager.unregisterAll();
        
        ztoolkit.log("Registering keyboard shortcuts...");

        // Register keyboard shortcut for chat panel
        const keyboardShortcut = getPref("keyboardShortcut").toLowerCase() || "l";
        keyboardManager.register(
            (ev, keyOptions) => {
                
                // Check for accel+l shortcut
                const isAccelL = (ev.key.toLowerCase() === keyboardShortcut && (ev.ctrlKey || ev.metaKey));
                
                if (isAccelL || keyOptions.keyboard?.equals(`accel,${keyboardShortcut}`)) {
                    // Prevent default behavior
                    ev.preventDefault();
                    
                    // The Reader view requires a different approach than the library view
                    let win;
                    
                    // First check if we're in a reader window
                    if (ev.target && (ev.target as HTMLElement).ownerDocument) {
                        const doc = (ev.target as HTMLElement).ownerDocument;
                        if (doc.defaultView) {
                            win = doc.defaultView;
                        }
                    }
                    
                    // If we couldn't get the window from the event target,
                    // fall back to the main window
                    if (!win) {
                        win = Zotero.getMainWindow();
                    }
                    
                    // Toggle the chat panel
                    triggerToggleChat(win);
                }
            }
        );
    }
    
    /**
     * Unregister all keyboard shortcuts 
     * Should be called during plugin shutdown or window unload
     */
    static unregisterShortcuts() {
        keyboardManager.unregisterAll();
    }
}