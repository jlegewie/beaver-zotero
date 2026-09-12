import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import { config, version } from "../package.json";
import hooks from "./hooks";
import { createBackgroundTaskSource } from "./utils/backgroundTasks";
import { BeaverInstance } from './runtime/instance';
import { BackgroundExtractor } from "./services/backgroundExtractor";
import type { NewItemWatcher } from "./services/backgroundProcessing/newItemWatcher";
import type { ReconcilerService } from "./services/backgroundProcessing/reconciler";
import { CitationService } from "./services/CitationService";
import { BeaverDB } from "./services/database";
import { DocumentCache } from "./services/documentCache";
import { LibraryMutations } from './services/libraryMutations';
import { LibraryOperations } from './services/libraryOperations';
import { NotePreviews } from './services/notePreviews';
import { AIProvider } from "./services/OpenAIProvider";
import { createSyncPauseService } from './services/syncPause';
import { createZToolkit } from "./utils/ztoolkit";

import type { DevelopmentVoiceHarness } from './services/voice/developmentHarness';
import type { VoiceService } from './services/voice/voiceService';

class Addon {
    public documents?: import("./services/instanceDocuments").InstanceDocuments;
    public background?: import("./services/instanceBackground").InstanceBackground;
    public backgroundTasks = createBackgroundTaskSource();
    public preferences?: import("./services/instancePreferences").InstancePreferences;
    public account?: import("./services/instanceAccount").InstanceAccount;
    public notePreviews = new NotePreviews();
    public syncPause = createSyncPauseService();
    public mutations = new LibraryMutations(
        token => {
            this.notePreviews.setMutationActive(true);
            this.syncPause.pauseSyncForMutatingRun(token);
        },
        token => {
            this.notePreviews.setMutationActive(false);
            this.syncPause.scheduleResumeAfterRun(token);
        },
    );
    public libraryOperations = new LibraryOperations();
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
