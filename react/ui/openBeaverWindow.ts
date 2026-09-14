import { openBeaverWindow as openWindow } from '../../src/ui/openBeaverWindow';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';

/** Focus the independent chat without replacing its contents. */
export function openBeaverWindow(
    minSize?: Parameters<typeof openWindow>[0],
): void {
    const runtime = tryGetWindowRuntime();
    if (!runtime || runtime.hostWindow.closed) return;
    openWindow(minSize, runtime.hostWindow);
}
