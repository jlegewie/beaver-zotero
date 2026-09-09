/**
 * Property stashed on the Beaver-authored `Zotero.Reader.onChangeSidebarWidth`
 * wrapper, holding whatever handler was installed before it (or null — core
 * initializes the slot to null and nothing else assigns it).
 */
const ORIGINAL_HANDLER_PROP = '__beaverOriginalSidebarWidthHandler';

type ReaderWidthHandler = (...args: any[]) => void;

/**
 * Wrappers installed by plugin versions that predate ORIGINAL_HANDLER_PROP
 * carry no marker and keep their original in instance state we cannot reach.
 * They are identified by two property accesses in their source (property
 * names survive minification). Since Zotero core initializes the slot to
 * null and nothing but Beaver assigns it, a legacy chain safely resolves to
 * null — letting an update reclaim compartments pinned by older versions.
 */
function isLegacyBeaverWrapper(fn: unknown): boolean {
    if (typeof fn !== 'function') {
        return false;
    }
    try {
        const src = Function.prototype.toString.call(fn);
        return src.includes('originalOnChangeSidebarWidth')
            && src.includes('enforceConsistentWidth');
    } catch (e) {
        return false;
    }
}

/**
 * Walk a chain of Beaver-authored wrappers down to the true original handler.
 * Returns null when the chain bottoms out at null/non-function, at a legacy
 * Beaver wrapper (see isLegacyBeaverWrapper), or when a wrapper from a
 * torn-down window realm can no longer be inspected — the only handler ever
 * underneath ours is core's initial null, so null is safe.
 */
export function unwrapReaderWidthHandler(handler: unknown): ReaderWidthHandler | null {
    try {
        let current: any = handler;
        while (typeof current === 'function' && ORIGINAL_HANDLER_PROP in current) {
            current = current[ORIGINAL_HANDLER_PROP];
        }
        if (isLegacyBeaverWrapper(current)) {
            return null;
        }
        return typeof current === 'function' ? current : null;
    } catch (e) {
        return null;
    }
}

/**
 * If a Beaver wrapper (installed by any bundle copy or plugin generation) is
 * present on `Zotero.Reader.onChangeSidebarWidth`, restore the original
 * handler so the wrapper's closure — and the compartment it pins — can be
 * garbage-collected. Safe to call repeatedly and from either bundle.
 */
export function restoreReaderSidebarWidthHandler(): void {
    try {
        const reader = Zotero?.Reader as any;
        if (!reader) {
            return;
        }
        const current = reader.onChangeSidebarWidth;
        if (
            typeof current === 'function'
            && (ORIGINAL_HANDLER_PROP in current || isLegacyBeaverWrapper(current))
        ) {
            reader.onChangeSidebarWidth = unwrapReaderWidthHandler(current);
        }
    } catch (e) {
        // Best-effort — never break shutdown.
    }
}


/** One plugin-owned callback fans out to attached renderers. */
export class ReaderWidthDispatcher {
    private listeners = new Set<() => void>();
    private wrapper: ReaderWidthHandler | null = null;

    subscribe(callback: () => void): () => void {
        this.install();
        this.listeners.add(callback);
        return () => { this.listeners.delete(callback); };
    }

    install(): void {
        const reader = Zotero.Reader;
        if (this.wrapper && reader.onChangeSidebarWidth === this.wrapper) return;
        const original = unwrapReaderWidthHandler(reader.onChangeSidebarWidth);
        const wrapper = (...args: any[]) => {
            try { original?.apply(reader, args); }
            finally {
                for (const listener of [...this.listeners]) {
                    try { listener(); } catch (error) { Zotero.logError(error as Error); }
                }
            }
        };
        (wrapper as any)[ORIGINAL_HANDLER_PROP] = original;
        reader.onChangeSidebarWidth = wrapper;
        this.wrapper = wrapper;
    }

    get isCurrent(): boolean { return this.wrapper !== null && Zotero.Reader.onChangeSidebarWidth === this.wrapper; }

    dispose(): void {
        this.listeners.clear();
        if (this.isCurrent) restoreReaderSidebarWidthHandler();
        this.wrapper = null;
    }
}
