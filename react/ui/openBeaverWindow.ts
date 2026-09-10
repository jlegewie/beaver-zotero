import { openBeaverWindow as openWindow } from '../../src/ui/openBeaverWindow';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';

/** A borrowed chat keeps the renderer that opened it for its entire lifetime. */
export function openBeaverWindow(minSize?: Parameters<typeof openWindow>[0]): void {
    const runtime = tryGetWindowRuntime();
    if (!runtime || runtime.contextWindow.closed) return;
    openWindow(minSize, runtime.contextWindow);
}
