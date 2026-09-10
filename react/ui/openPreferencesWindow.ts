import { openPreferencesWindow as openWindow } from '../../src/ui/openPreferencesWindow';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';

/** Open preferences with this renderer's context, including from borrowed surfaces. */
export function openPreferencesWindow(...args: Parameters<typeof openWindow>): void {
    const runtime = tryGetWindowRuntime();
    if (!runtime || runtime.contextWindow.closed) return;
    openWindow(args[0], args[1], args[2], args[3] ?? runtime.contextWindow);
}
