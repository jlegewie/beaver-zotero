/**
 * Load the export runtime: the parser and writers (Word, HTML for PDF,
 * Markdown, LaTeX) of `@beaver/agent-export` with their dependencies (remark,
 * KaTeX, docx).
 * They are bundled separately (`content/scripts/beaver-export.js`) and loaded
 * on first export, so the plugin's main bundle does not carry them at startup.
 */

import type * as ExportRuntimeModule from '@beaver/agent-export/runtime';
import { libraryRefForLibraryID, resolveObjectId } from '../../utils/libraryIdentity';
import { getSystemTimers } from '../../utils/systemTimers';

export type ExportRuntime = typeof ExportRuntimeModule;

/**
 * Loaded through the registered chrome URL: Firefox 153 refuses `loadSubScript`
 * of the XPI's own `jar:` / `file:` URIs.
 */
const RUNTIME_SCRIPT = 'chrome://beaver/content/scripts/beaver-export.js';
const RUNTIME_GLOBAL = 'BeaverExportRuntime';

/**
 * Globals the bundle's dependencies expect but a script scope lacks. JSZip
 * (inside docx) needs `setImmediate`: without it, its polyfill picks a
 * message-channel path that never fires here and writing a file hangs.
 */
function createScope(): Record<string, unknown> {
    const { setTimeout, clearTimeout } = getSystemTimers();
    return {
        setTimeout,
        clearTimeout,
        setImmediate: (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
            Promise.resolve().then(() => callback(...args));
            return 0;
        },
        clearImmediate: () => {},
    };
}

/** Load the runtime into its own scope. */
export function loadExportRuntime(): ExportRuntime {
    const scope = createScope();
    // `ignoreCache`: the script cache is keyed by URL, which stays the same
    // across plugin updates and reloads.
    Services.scriptloader.loadSubScriptWithOptions(RUNTIME_SCRIPT, { target: scope, ignoreCache: true });
    const runtime = scope[RUNTIME_GLOBAL] as ExportRuntime | undefined;
    if (!runtime?.parseExportSource || !runtime.writeDocx || !runtime.writeHtml || !runtime.writeMarkdown || !runtime.writeLatex) {
        throw new Error('The export runtime did not load');
    }
    // The runtime's agent-core copy has its own identity registry; without
    // these, legacy `<libraryID>-KEY` citations would key differently from the
    // metadata the renderer captured.
    runtime.setObjectIdResolver(resolveObjectId);
    runtime.setLibraryRefResolver(libraryRefForLibraryID);
    return runtime;
}
