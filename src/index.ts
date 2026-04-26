import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";

const basicTool = new BasicTool();

// Always construct a fresh Addon on script load
_globalThis.addon = new Addon();
defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
});
// @ts-ignore - Plugin instance is not typed
Zotero[config.addonInstance] = _globalThis.addon;

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
    // `configurable: true` so a re-define (defensive — should not happen in
    // practice since each reload spawns a new sandbox) does not throw.
    Object.defineProperty(_globalThis, name, {
        configurable: true,
        get() {
            return getter ? getter() : basicTool.getGlobal(name);
        },
    });
}
