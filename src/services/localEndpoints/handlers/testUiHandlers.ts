/**
 * Dev-only HTTP handlers for UI lifecycle state: the cleanup of
 * `Zotero.Reader.onChangeSidebarWidth` wrappers left by earlier plugin
 * versions, and window runtime commands.
 */
import {
    restoreReaderSidebarWidthHandler,
    unwrapReaderWidthHandler,
} from '../../../runtime/readerWidth';

const ORIGINAL_HANDLER_PROP = '__beaverOriginalSidebarWidthHandler';

type AnyFn = (...args: any[]) => void;

/** Fabricate a wrapper shaped like one from another plugin generation. */
function makeTaggedWrapper(original: AnyFn | null): AnyFn {
    const wrapper = (width: number) => {
        if (original) original(width);
    };
    (wrapper as any)[ORIGINAL_HANDLER_PROP] = original;
    return wrapper;
}

/**
 * Fabricate a wrapper shaped like one installed by plugin versions that
 * predate the marker property: untagged, original held in closure state,
 * and the two identifying property accesses present in the source.
 */
function makeLegacyWrapper(): AnyFn {
    const _this: any = {
        originalOnChangeSidebarWidth: null,
        enforceConsistentWidth: () => {},
    };
    return function (width: number) {
        if (_this.originalOnChangeSidebarWidth) {
            _this.originalOnChangeSidebarWidth.call(null, width);
        }
        setTimeout(() => _this.enforceConsistentWidth(), 50);
    };
}

/** A plain handler, standing in for Zotero's or another plugin's. */
function makePlainFn(): AnyFn {
    return () => {};
}

function describeSlot(reader: any): Record<string, unknown> {
    const slot = reader.onChangeSidebarWidth;
    let taggedLayers = 0;
    let cur: any = slot;
    let guard = 0;
    while (typeof cur === 'function' && ORIGINAL_HANDLER_PROP in cur && guard++ < 20) {
        taggedLayers += 1;
        cur = cur[ORIGINAL_HANDLER_PROP];
    }
    return {
        slotType: slot === null ? 'null' : typeof slot,
        taggedLayers,
        bottom: cur === null ? 'null' : typeof cur,
    };
}

export async function handleTestSidebarWidthHandlerHttpRequest(request: any) {
    const { scenario } = request ?? {};
    const reader = (Zotero as any)?.Reader;
    if (!reader) {
        return { error: 'Zotero.Reader not available' };
    }

    if (scenario === 'inspect') {
        return { ok: true, ...describeSlot(reader) };
    }

    // Mutating scenarios: snapshot slot + instance state, restore in finally.
    const savedSlot = reader.onChangeSidebarWidth;
    try {
        switch (scenario) {
            case 'restore-unwinds-own': {
                const base = makePlainFn();
                reader.onChangeSidebarWidth = makeTaggedWrapper(makeTaggedWrapper(base));
                restoreReaderSidebarWidthHandler();
                return { ok: true, slotIsBase: reader.onChangeSidebarWidth === base };
            }
            case 'restore-clears-bare-legacy': {
                reader.onChangeSidebarWidth = makeLegacyWrapper();
                restoreReaderSidebarWidthHandler();
                return { ok: true, slotIsNull: reader.onChangeSidebarWidth === null };
            }
            case 'restore-leaves-foreign': {
                const foreign = makePlainFn();
                reader.onChangeSidebarWidth = foreign;
                restoreReaderSidebarWidthHandler();
                return { ok: true, slotIsForeign: reader.onChangeSidebarWidth === foreign };
            }
            case 'unwrap-direct': {
                const base = makePlainFn();
                const chain = makeTaggedWrapper(makeTaggedWrapper(base));
                return {
                    ok: true,
                    unwrapsChainToBase: unwrapReaderWidthHandler(chain) === base,
                    unwrapsLegacyToNull: unwrapReaderWidthHandler(makeLegacyWrapper()) === null,
                    unwrapsNullToNull: unwrapReaderWidthHandler(null) === null,
                };
            }
            default:
                return { error: `unknown scenario: ${String(scenario)}` };
        }
    } finally {
        reader.onChangeSidebarWidth = savedSlot;
    }
}

/** Resolve once at entry; commands never import another renderer's atoms. */
export async function handleTestWindowRuntimeHttpRequest(request: any) {
    const instance = Zotero.Beaver.runtime;
    if (request?.command === 'list') return { windows: instance.getSnapshot() };
    const runtime = instance.resolveWindow(request?.windowId);
    if (!runtime) return { error: 'window_unavailable' };
    const itemId = request?.itemId ?? (request?.library_id && request?.zotero_key
        ? Zotero.Items.getIDFromLibraryAndKey(request.library_id, request.zotero_key) : undefined);
    try {
        const result = await instance.dispatchWindowCommand('inspect-runtime',
            { windowId: runtime.id, command: request?.command, threadId: request?.threadId, text: request?.text, runId: request?.runId, itemId, draft: request?.draft, mutation: request?.mutation, undo: request?.undo },
        );
        return runtime.status === 'closing' || runtime.hostWindow.closed ? { error: 'window_unavailable' } : result;
    } catch (error) {
        if ((error as any)?.code === 'window_unavailable') return { error: 'window_unavailable' };
        throw error;
    }
}
