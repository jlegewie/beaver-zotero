import type { WindowRuntime } from '../../src/runtime/instance';

let runtime: WindowRuntime | undefined;

export function initializeWindowRuntime(value: WindowRuntime): void {
    if (runtime && runtime !== value) throw new Error('Renderer already belongs to another window');
    runtime = value;
}

/** Late UI callbacks may run before initialization or during teardown. */
export function tryGetWindowRuntime(): WindowRuntime | undefined {
    return runtime?.status === 'closing' ? undefined : runtime;
}

export function getWindowRuntime(): WindowRuntime {
    const current = tryGetWindowRuntime();
    if (!current) throw new Error('Window runtime unavailable');
    return current;
}

export function getHostWindow(): Window { return getWindowRuntime().hostWindow; }
export function getContextWindow(): ReturnType<typeof Zotero.getMainWindow> {
    return getWindowRuntime().contextWindow as ReturnType<typeof Zotero.getMainWindow>;
}
