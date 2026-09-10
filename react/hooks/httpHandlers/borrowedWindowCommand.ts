import { BeaverUIFactory } from '../../../src/ui/ui';
import { tryGetWindowRuntime } from '../../runtime/windowRuntime';

/** Dev surface commands must never mutate one store while displaying another. */
export function borrowedWindowCommandError(): { ok: false; error: string } | null {
    const runtime = tryGetWindowRuntime();
    if (!runtime || runtime.contextWindow.closed) return { ok: false, error: 'window_unavailable' };
    const existing = BeaverUIFactory.findBeaverWindow();
    if (existing && !existing.closed && existing.__beaverOwnerWindowRef?.deref() !== runtime.contextWindow) {
        return { ok: false, error: 'window_owned_by_another_renderer' };
    }
    return null;
}
