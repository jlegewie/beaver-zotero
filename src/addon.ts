import { BeaverInstance } from './runtime/instance';
import { config, version } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import { BeaverDB } from "./services/database";
import { AIProvider } from "./services/OpenAIProvider";
import { CitationService } from "./services/CitationService";
import { DocumentCache } from "./services/documentCache";
import { BackgroundExtractor } from "./services/backgroundExtractor";
import type { ReconcilerService } from "./services/backgroundProcessing/reconciler";
import type { NewItemWatcher } from "./services/backgroundProcessing/newItemWatcher";

import type { VoiceService } from './services/voice/voiceService';
import type { DevelopmentVoiceHarness } from './services/voice/developmentHarness';

class Addon {
    public preferences?: import("./services/instancePreferences").InstancePreferences;
    public account?: import("./services/instanceAccount").InstanceAccount;
    public runtime = new BeaverInstance();
    public voiceNative?: import("./services/voice/nativeVoice").NativeVoice;
    public voice?: VoiceService;
    public voiceHarness?: DevelopmentVoiceHarness;
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
    };
    public aiProvider?: AIProvider;
    public citationService?: CitationService;
    public db?: BeaverDB;
    public documentCache?: DocumentCache;
    public backgroundExtractor?: BackgroundExtractor;
    public processingReconciler?: ReconcilerService;
    public newItemWatcher?: NewItemWatcher;
    public pluginVersion?: typeof version;
    /** Instance-owned OCR entitlement */
    public hasOcrAccess: boolean = false;
    /** Instance-owned cloud search-index entitlement */
    public hasSearchIndexAccess: boolean = false;
    public searchableLibraryIds: number[] = [];
    public libraryScopeInitialized: boolean = false;
    // Lifecycle hooks
    public hooks: typeof hooks;
    // APIs
    public api: object;
    
    constructor() {
        this.data = {
            alive: true,
            config,
            env: __env__,
            ztoolkit: createZToolkit()
        };
        this.hooks = hooks;
        this.api = {};
    }
}

export default Addon;
