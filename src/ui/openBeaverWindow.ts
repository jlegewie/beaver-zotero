import { BeaverUIFactory } from './ui';

/**
 * Open Beaver in a separate window.
 * If a window already exists, it will be focused instead.
 *
 * `minSize` only ever grows the window — see `BeaverUIFactory.openBeaverWindow`.
 */
export function openBeaverWindow(minSize?: { width?: number; height?: number }): void {
    BeaverUIFactory.openBeaverWindow(minSize);
}
