import { KeyModifier } from "zotero-plugin-toolkit/dist/managers/keyboard";

/**
 * Custom keyboard manager that properly handles accelerator key combinations
 */
export class KeyboardManager {
    private _keyboardCallbacks = new Set<(event: KeyboardEvent, options: { keyboard?: KeyModifier; type: "keydown" | "keyup" }) => void>();
    // Track keyboard events that are currently being processed to prevent duplicates
    private _activeKeyEvents = new Map<string, number>();
    private id: string;
    private _initializedWindows = new Set<Window>();
    private _initializedReaders = new Set<any>();
    private _addonID = "beaver@jlegewie.com"; // Keep the hardcoded ID for now
    private _reinitInterval: NodeJS.Timeout | null = null;

    constructor() {
        this.id = Math.random().toString(36).substring(2, 15);
        this.initKeyboardListener();
        
        // Re-initialize on a regular basis to catch any new windows/readers
        // that might have been opened
        this._reinitInterval = setInterval(() => {
            this.initKeyboardListener();
        }, 5000);
    }

    /**
     * Register a keyboard event listener.
     * @param callback The callback function.
     */
    register(callback: (event: KeyboardEvent, options: { keyboard?: KeyModifier; type: "keydown" | "keyup" }) => void) {
        this._keyboardCallbacks.add(callback);
        
        // Re-initialize listeners - ensures we capture any new windows/readers
        this.initKeyboardListener();
        return this;
    }

    /**
     * Unregister a keyboard event listener.
     * @param callback The callback function.
     */
    unregister(callback: (event: KeyboardEvent, options: { keyboard?: KeyModifier; type: "keydown" | "keyup" }) => void) {
        this._keyboardCallbacks.delete(callback);
        return this;
    }

    /**
     * Unregister all keyboard event listeners.
     */
    unregisterAll() {
        this._keyboardCallbacks.clear();
        this.unInitKeyboardListener();
        this._activeKeyEvents.clear();
        
        // Clear the re-initialization interval
        if (this._reinitInterval) {
            clearInterval(this._reinitInterval);
            this._reinitInterval = null;
        }
    }

    private initKeyboardListener() {
        // Initialize for main window
        const win = Zotero.getMainWindow();
        if (win) {
            this._initKeyboardListener(win);
        }

        // Observe for any new windows
        Zotero.getMainWindows().forEach(window => {
            if (!this._initializedWindows.has(window)) {
                this._initKeyboardListener(window);
            }
        });

        // Initialize for reader windows
        this.initReaderKeyboardListener();
    }

    private initReaderKeyboardListener() {
        const addonID = this._addonID;
        
        // Register for future readers
        Zotero.Reader.registerEventListener(
            "renderToolbar", 
            (event) => this.addReaderKeyboardCallback(event), 
            addonID
        );
        
        // Initialize for existing readers
        Zotero.Reader._readers.forEach((reader) => {
            if (!this._initializedReaders.has(reader)) {
                this.addReaderKeyboardCallback({ reader });
            }
        });
    }

    private async addReaderKeyboardCallback(event: { reader: any }) {
        const reader = event.reader;
        
        // Skip if already initialized
        if (this._initializedReaders.has(reader)) {
            return;
        }
        
        this._initializedReaders.add(reader);
        
        try {
            // Simplify the reader window initialization
            if (reader._iframeWindow) {
                this._initKeyboardListener(reader._iframeWindow);
            } else {
                // For readers that are still loading
                const waitForReaderWindow = () => {
                    return new Promise<Window | null>((resolve) => {
                        const checkInterval = setInterval(() => {
                            if (reader._iframeWindow) {
                                clearInterval(checkInterval);
                                resolve(reader._iframeWindow);
                            }
                        }, 100);
                        
                        // Set a timeout to avoid waiting forever
                        setTimeout(() => {
                            clearInterval(checkInterval);
                            resolve(null);
                        }, 5000);
                    });
                };
                
                const readerWindow = await waitForReaderWindow();
                if (readerWindow) {
                    this._initKeyboardListener(readerWindow);
                }
            }
            
            // Also initialize the internal PDF reader if it exists
            if (reader._internalReader?._iframe?.contentWindow) {
                this._initKeyboardListener(reader._internalReader._iframe.contentWindow);
            }
        } catch (e) {
            ztoolkit.log("Error initializing reader keyboard listener:", e);
        }
    }

    private _initKeyboardListener(win: Window) {
        if (!win || this._initializedWindows.has(win)) {
            return;
        }
        
        this._initializedWindows.add(win);
        
        // Add event listeners for keydown and keyup
        win.addEventListener('keydown', this.triggerKeydown, true);
        win.addEventListener('keyup', this.triggerKeyup, true);
        
        // Add cleanup when window is closed
        win.addEventListener('unload', () => {
            this._unInitKeyboardListener(win);
        }, { once: true });
    }

    private unInitKeyboardListener() {
        // Clean up all initialized windows
        for (const win of this._initializedWindows) {
            this._unInitKeyboardListener(win);
        }
        
        // Clean up reader event listeners
        try {
            // Note: We should unregister the reader event listener here
            // but there are type mismatches with Zotero.Reader.unregisterEventListener
            // This should be revisited later
            // Zotero.Reader.unregisterEventListener("renderToolbar", this._addonID);
        } catch (e) {
            // Ignore errors during cleanup
        }
        
        this._initializedWindows.clear();
        this._initializedReaders.clear();
    }

    private _unInitKeyboardListener(win: Window) {
        if (!win || !this._initializedWindows.has(win)) {
            return;
        }
        
        try {
            win.removeEventListener('keydown', this.triggerKeydown, true);
            win.removeEventListener('keyup', this.triggerKeyup, true);
            this._initializedWindows.delete(win);
        } catch (e) {
            // Window might be closed already, just remove from our set
            this._initializedWindows.delete(win);
        }
    }

    private triggerKeydown = (e: KeyboardEvent) => {
        // Create the keyboard modifier
        const keyboard = new KeyModifier(e);
        
        // Get string representation for tracking
        const keyId = keyboard.toString();
        
        
        // Special handling for modifier-only keypresses
        if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') {
            // Just track modifiers without triggering callbacks
            this._activeKeyEvents.set(e.key, Date.now());
            return;
        }
        
        // For all other keys, especially when combined with modifiers
        try {
            this.dispatchCallback(e, { keyboard, type: "keydown" });
        } catch (err) {
            ztoolkit.log('Error dispatching keyboard callback:', err);
        }
    };

    private triggerKeyup = (e: KeyboardEvent) => {
        const keyboard = new KeyModifier(e);
        const keyId = keyboard.toString();
        
        // Clean up tracking
        if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') {
            this._activeKeyEvents.delete(e.key);
            return;
        }
        
        // Only dispatch for non-modifier keys
        try {
            this.dispatchCallback(e, { keyboard, type: "keyup" });
        } catch (err) {
            ztoolkit.log('Error dispatching keyboard callback:', err);
        }
    };

    private dispatchCallback(...args: [KeyboardEvent, { keyboard?: KeyModifier; type: "keydown" | "keyup" }]) {
        for (const callback of this._keyboardCallbacks) {
            try {
                callback(...args);
            } catch (e) {
                ztoolkit.log("Error in keyboard callback:", e);
            }
        }
    }
} 