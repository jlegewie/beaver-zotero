import { config, version } from "../package.json";
import { ColumnOptions } from "zotero-plugin-toolkit/dist/helpers/virtualizedTable";
import { DialogHelper } from "zotero-plugin-toolkit/dist/helpers/dialog";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import { BeaverDB } from "./services/database";
import { AIProvider } from "./services/OpenAIProvider";
import { CitationService } from "./services/CitationService";

class Addon {
    public data: {
        alive: boolean;
        config: typeof config;
        // Env type, see build.js
        env: "development" | "production";
        ztoolkit: ZToolkit;
        locale?: {
            current: any;
        };
        prefs?: {
            window: Window;
            columns: Array<ColumnOptions>;
            rows: Array<{ [dataKey: string]: string }>;
        };
        dialog?: DialogHelper;
        _itemStatuses: Map<number, string>;
        // Track active Zotero notifier observers for cleanup
        _activeZoteroObservers: Set<string>;
    };
    public aiProvider?: AIProvider;
    public citationService?: CitationService;
    public db?: BeaverDB;
    public pluginVersion?: typeof version;
    // Lifecycle hooks
    public hooks: typeof hooks;
    // APIs
    public api: object;
    
    constructor() {
        this.data = {
            alive: true,
            config,
            env: __env__,
            ztoolkit: createZToolkit(),
            _itemStatuses: new Map(),
            _activeZoteroObservers: new Set()
        };
        this.hooks = hooks;
        this.api = {};
    }

    /**
     * Register a Zotero notifier observer for tracking
     */
    public registerZoteroObserver(observerId: string): void {
        this.data._activeZoteroObservers.add(observerId);
        ztoolkit.log(`Registered Zotero observer in addon: ${observerId}`);
    }

    /**
     * Unregister a Zotero notifier observer from tracking
     */
    public unregisterZoteroObserver(observerId: string): void {
        this.data._activeZoteroObservers.delete(observerId);
        ztoolkit.log(`Unregistered Zotero observer from addon: ${observerId}`);
    }

    /**
     * Get all active observer IDs
     */
    public getActiveZoteroObservers(): string[] {
        return Array.from(this.data._activeZoteroObservers);
    }

    /**
     * Clean up all remaining observers (for shutdown)
     */
    public cleanupAllZoteroObservers(): void {
        const observerIds = Array.from(this.data._activeZoteroObservers);
        
        ztoolkit.log(`Addon cleanup: Found ${observerIds.length} active observers: ${observerIds.join(', ')}`);
        
        if (observerIds.length > 0) {
            ztoolkit.log(`Cleaning up ${observerIds.length} remaining Zotero notifier observers`);
            
            for (const observerId of observerIds) {
                try {
                    Zotero.Notifier.unregisterObserver(observerId);
                    ztoolkit.log(`Manually unregistered Zotero notifier observer: ${observerId}`);
                } catch (err) {
                    ztoolkit.log(`Error unregistering observer ${observerId}:`, err);
                }
            }
            
            this.data._activeZoteroObservers.clear();
            ztoolkit.log("All observers cleaned up from addon");
        }
    }
}

export default Addon;
