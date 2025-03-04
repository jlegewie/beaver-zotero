import { config } from "../package.json";
import { ColumnOptions } from "zotero-plugin-toolkit/dist/helpers/virtualizedTable";
import { DialogHelper } from "zotero-plugin-toolkit/dist/helpers/dialog";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import { VectorStoreDB } from "./services/vectorStore";
import { VoyageClient } from "./services/voyage";
import { ItemService } from "./services/ItemService";
import { QuickChat } from "./ui/quickChat"
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
    };
    public itemService?: ItemService;
    public aiProvider?: AIProvider;
    public citationService?: CitationService;
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
            _itemStatuses: new Map()
        };
        this.hooks = hooks;
        this.api = {};
    }
}

export default Addon;
