import { KeyModifier } from "zotero-plugin-toolkit";

/**
 * Custom keyboard manager that properly handles accelerator key combinations.
 * 
 * IMPORTANT: This class registers event listeners with Zotero.Reader that MUST
 * be unregistered during shutdown to prevent SIGSEGV crashes. Always call
 * unregisterAll() before Zotero shuts down.
 */
export class KeyboardManager {
    private _keyboardCallbacks = new Set<(event: KeyboardEvent, options: { keyboard?: KeyModifier; type: "keydown" | "keyup" }) => void>();
    private _activeKeyEvents = new Map<string, number>();
    private id: string;
    private _initializedWindows = new Set<Window>();
    private _initializedReaders = new Set<any>();
    private _addonID = "beaver@jlegewie.com";
    private _intervalId: ReturnType<typeof setInterval> | null = null;
    private _readerListenerRegistered = false;
    private _readerListenerActive = false;
    private _readerEventCallback: ((event: { reader: any }) => void) | null = null;

    constructor() {
        this.id = Math.random().toString(36).substring(2, 15);
        this.initKeyboardListener();
        
        // Re-initialize on a regular basis to catch any new windows/readers
        this._intervalId = setInterval(() => {
            this.initKeyboardListener();
        }, 5000);
    }

    /**
     * Register a keyboard event listener.
     */
    register(callback: (event: KeyboardEvent, options: { keyboard?: KeyModifier; type: "keydown" | "keyup" }) => void) {
        this._keyboardCallbacks.add(callback);
        this.initKeyboardListener();
        
        // Restart the interval if it was stopped (e.g., after unregisterAll)
        if (!this._intervalId) {
            this._intervalId = setInterval(() => {
                this.initKeyboardListener();
            }, 5000);
        }
        
        return this;
    }

    /**
     * Unregister a keyboard event listener.
     */
    unregister(callback: (event: KeyboardEvent, options: { keyboard?: KeyModifier; type: "keydown" | "keyup" }) => void) {
        this._keyboardCallbacks.delete(callback);
        return this;
    }

    /**
     * Unregister all keyboard event listeners and clean up resources.
     * 
     * CRITICAL: This must be called during shutdown to:
     * 1. Clear the interval to prevent it from firing during cleanup
     * 2. Unregister Zotero.Reader event listeners to prevent SIGSEGV
     */
    unregisterAll() {
        // Clear the interval first to prevent it from firing during cleanup
        if (this._intervalId) {
            clearInterval(this._intervalId);
            this._intervalId = null;
        }
        
        this._keyboardCallbacks.clear();
        this.unInitKeyboardListener();
        this._activeKeyEvents.clear();
    }

    private initKeyboardListener() {
        try {
            // Initialize for main window
            const win = Zotero.getMainWindow();
            if (win && !win.closed) {
                this._initKeyboardListener(win);
            }

            // Initialize for any additional windows
            const mainWindows = Zotero.getMainWindows();
            mainWindows?.forEach(window => {
                if (window && !window.closed && !this._initializedWindows.has(window)) {
                    this._initKeyboardListener(window);
                }
            });

            // Initialize for reader windows
            this.initReaderKeyboardListener();
        } catch (e) {
            // Silently handle errors during initialization
        }
    }

    private initReaderKeyboardListener() {
        try {
            if (!Zotero?.Reader) {
                return;
            }
            
            // Only register once to avoid duplicate registrations
            if (!this._readerListenerRegistered) {
                // Store callback reference for later unregistration
                this._readerListenerActive = true;
                this._readerEventCallback = (event) => {
                    if (!this._readerListenerActive) {
                        return;
                    }
                    this.addReaderKeyboardCallback(event);
                };
                Zotero.Reader.registerEventListener(
                    "renderToolbar", 
                    this._readerEventCallback, 
                    this._addonID
                );
                this._readerListenerRegistered = true;
            }
            
            // Initialize for existing readers
            Zotero.Reader._readers?.forEach((reader) => {
                if (!this._initializedReaders.has(reader)) {
                    this.addReaderKeyboardCallback({ reader });
                }
            });
        } catch (e) {
            // Silently handle errors
        }
    }

    private async addReaderKeyboardCallback(event: { reader: any }) {
        const reader = event.reader;
        
        if (this._initializedReaders.has(reader)) {
            return;
        }
        
        this._initializedReaders.add(reader);
        
        try {
            if (reader._iframeWindow) {
                this._initKeyboardListener(reader._iframeWindow);
            } else {
                // Wait for reader window to be available
                const waitForReaderWindow = () => {
                    return new Promise<Window | null>((resolve) => {
                        const checkInterval = setInterval(() => {
                            if (reader._iframeWindow) {
                                clearInterval(checkInterval);
                                resolve(reader._iframeWindow);
                            }
                        }, 100);
                        
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
        
        win.addEventListener('keydown', this.triggerKeydown, true);
        win.addEventListener('keyup', this.triggerKeyup, true);
        
        // Clean up when window is closed
        win.addEventListener('unload', () => {
            try {
                this._unInitKeyboardListener(win);
            } catch (e) {
                // Ignore errors during cleanup
            }
        }, { once: true });
    }

    private unInitKeyboardListener() {
        // Clean up all initialized windows
        for (const win of this._initializedWindows) {
            this._unInitKeyboardListener(win);
        }
        
        // CRITICAL: Unregister reader event listener to prevent SIGSEGV during shutdown
        if (this._readerListenerRegistered && this._readerEventCallback && Zotero?.Reader) {
            try {
                this._readerListenerActive = false;
                const removed = this.removeReaderListenerSafely(
                    "renderToolbar",
                    this._readerEventCallback
                );
                if (!removed) {
                    ztoolkit.log("KeyboardManager: Unable to remove reader listener safely; skipping unregisterEventListener.");
                }
                this._readerListenerRegistered = false;
                this._readerEventCallback = null;
            } catch (e) {
                // Ignore errors during cleanup
            }
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
            this._initializedWindows.delete(win);
        }
    }

    private removeReaderListenerSafely(
        type: string,
        handler: (event: { reader: any }) => void
    ): boolean {
        const reader = Zotero?.Reader as any;
        const listeners = reader?._registeredListeners;
        if (!Array.isArray(listeners)) {
            return false;
        }
        reader._registeredListeners = listeners.filter(
            (listener: { type?: string; handler?: unknown }) =>
                !(listener?.type === type && listener?.handler === handler)
        );
        return true;
    }

    private triggerKeydown = (e: KeyboardEvent) => {
        const keyboard = new KeyModifier(e);
        
        // Special handling for modifier-only keypresses
        if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') {
            this._activeKeyEvents.set(e.key, Date.now());
            return;
        }
        
        try {
            this.dispatchCallback(e, { keyboard, type: "keydown" });
        } catch (err) {
            ztoolkit.log('Error dispatching keyboard callback:', err);
        }
    };

    private triggerKeyup = (e: KeyboardEvent) => {
        const keyboard = new KeyModifier(e);
        
        if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') {
            this._activeKeyEvents.delete(e.key);
            return;
        }
        
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
