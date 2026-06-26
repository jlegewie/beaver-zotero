import { config, version } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import { BeaverDB } from "./services/database";
import { AIProvider } from "./services/OpenAIProvider";
import { CitationService } from "./services/CitationService";
import { DocumentCache } from "./services/documentCache";
import { BackgroundExtractor } from "./services/backgroundExtractor";

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
    };
    public aiProvider?: AIProvider;
    public citationService?: CitationService;
    public db?: BeaverDB;
    public documentCache?: DocumentCache;
    public backgroundExtractor?: BackgroundExtractor;
    public pluginVersion?: typeof version;
    /**
     * OCR entitlement mirror kept in sync from the webpack profile hook. The
     * esbuild enqueue gate reads this before creating OCR jobs, and the backend
     * still enforces entitlement on `/ocr/request`.
     */
    public hasOcrAccess: boolean = false;
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
