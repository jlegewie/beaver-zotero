/**
 * Dev-only HTTP handlers for UI lifecycle state — currently the
 * `Zotero.Reader.onChangeSidebarWidth` wrapper installed by UIManager.
 */
import {
    uiManager,
    restoreReaderSidebarWidthHandler,
    unwrapReaderWidthHandler,
} from '../../ui/UIManager';

const ORIGINAL_HANDLER_PROP = '__beaverOriginalSidebarWidthHandler';

type AnyFn = (...args: any[]) => void;

/** Fabricate a wrapper shaped like one from another plugin generation. */
function makeTaggedWrapper(original: AnyFn | null): AnyFn & { calls: number } {
    const wrapper = ((width: number) => {
        wrapper.calls += 1;
        if (original) original(width);
    }) as AnyFn & { calls: number };
    wrapper.calls = 0;
    (wrapper as any)[ORIGINAL_HANDLER_PROP] = original;
    return wrapper;
}

/**
 * Fabricate a wrapper shaped like one installed by plugin versions that
 * predate the marker property: untagged, original held in closure state,
 * and the two identifying property accesses present in the source.
 */
function makeLegacyWrapper(): AnyFn & { calls: number } {
    const _this: any = {
        originalOnChangeSidebarWidth: null,
        enforceConsistentWidth: () => {},
    };
    const legacy = (function (width: number) {
        legacy.calls += 1;
        if (_this.originalOnChangeSidebarWidth) {
            _this.originalOnChangeSidebarWidth.call(null, width);
        }
        setTimeout(() => _this.enforceConsistentWidth(), 50);
    }) as AnyFn & { calls: number };
    legacy.calls = 0;
    return legacy;
}

function makeCountingFn(): AnyFn & { calls: number; lastWidth: number | null } {
    const fn = ((width: number) => {
        fn.calls += 1;
        fn.lastWidth = width;
    }) as AnyFn & { calls: number; lastWidth: number | null };
    fn.calls = 0;
    fn.lastWidth = null;
    return fn;
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
        ownWrapperCurrent:
            !!(uiManager as any).installedReaderWidthWrapper
            && slot === (uiManager as any).installedReaderWidthWrapper,
    };
}

/** Run the real (private) install path on the production singleton. */
function runInstall(): void {
    (uiManager as any).initSidebarWidthTracking();
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
    const savedOwn = (uiManager as any).installedReaderWidthWrapper;
    try {
        switch (scenario) {
            case 'install-over-plain-original': {
                const base = makeCountingFn();
                reader.onChangeSidebarWidth = base;
                (uiManager as any).installedReaderWidthWrapper = null;
                runInstall();
                const installed = reader.onChangeSidebarWidth;
                const tagged =
                    typeof installed === 'function' && ORIGINAL_HANDLER_PROP in installed;
                installed(271);
                return {
                    ok: true,
                    installedTagged: tagged,
                    originalIsBase: (installed as any)[ORIGINAL_HANDLER_PROP] === base,
                    basePropagatedWidth: base.lastWidth,
                };
            }
            case 'replace-stale-tagged': {
                const base = makeCountingFn();
                const stale = makeTaggedWrapper(base);
                reader.onChangeSidebarWidth = stale;
                (uiManager as any).installedReaderWidthWrapper = null;
                runInstall();
                const installed = reader.onChangeSidebarWidth;
                installed(272);
                return {
                    ok: true,
                    replacedStale: installed !== stale,
                    originalIsBase: (installed as any)[ORIGINAL_HANDLER_PROP] === base,
                    baseCalls: base.calls,
                    staleCalls: stale.calls,
                };
            }
            case 'replace-legacy': {
                const legacy = makeLegacyWrapper();
                reader.onChangeSidebarWidth = legacy;
                (uiManager as any).installedReaderWidthWrapper = null;
                runInstall();
                const installed = reader.onChangeSidebarWidth;
                let invokeError: string | null = null;
                try {
                    installed(273);
                } catch (e: any) {
                    invokeError = String(e?.message ?? e);
                }
                return {
                    ok: true,
                    replacedLegacy: installed !== legacy,
                    installedTagged:
                        typeof installed === 'function' && ORIGINAL_HANDLER_PROP in installed,
                    originalIsNull: (installed as any)[ORIGINAL_HANDLER_PROP] === null,
                    legacyCalls: legacy.calls,
                    invokeError,
                };
            }
            case 'restore-unwinds-own': {
                const base = makeCountingFn();
                reader.onChangeSidebarWidth = base;
                (uiManager as any).installedReaderWidthWrapper = null;
                runInstall();
                restoreReaderSidebarWidthHandler();
                return { ok: true, slotIsBase: reader.onChangeSidebarWidth === base };
            }
            case 'restore-clears-bare-legacy': {
                reader.onChangeSidebarWidth = makeLegacyWrapper();
                restoreReaderSidebarWidthHandler();
                return { ok: true, slotIsNull: reader.onChangeSidebarWidth === null };
            }
            case 'restore-leaves-foreign': {
                const foreign = makeCountingFn();
                reader.onChangeSidebarWidth = foreign;
                restoreReaderSidebarWidthHandler();
                return { ok: true, slotIsForeign: reader.onChangeSidebarWidth === foreign };
            }
            case 'own-wrapper-skip': {
                const base = makeCountingFn();
                reader.onChangeSidebarWidth = base;
                (uiManager as any).installedReaderWidthWrapper = null;
                runInstall();
                const first = reader.onChangeSidebarWidth;
                runInstall();
                return { ok: true, sameWrapper: reader.onChangeSidebarWidth === first };
            }
            case 'reinstall-after-displacement': {
                const base = makeCountingFn();
                reader.onChangeSidebarWidth = base;
                (uiManager as any).installedReaderWidthWrapper = null;
                runInstall();
                const own = reader.onChangeSidebarWidth;
                const displacer = makeTaggedWrapper(own);
                reader.onChangeSidebarWidth = displacer;
                runInstall();
                const reinstalled = reader.onChangeSidebarWidth;
                reinstalled(274);
                return {
                    ok: true,
                    replacedDisplacer: reinstalled !== displacer && reinstalled !== own,
                    originalIsBase: (reinstalled as any)[ORIGINAL_HANDLER_PROP] === base,
                    baseCalls: base.calls,
                    displacerCalls: displacer.calls,
                };
            }
            case 'unwrap-direct': {
                const base = makeCountingFn();
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
        (uiManager as any).installedReaderWidthWrapper = savedOwn;
    }
}
