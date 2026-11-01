import { BeaverUIFactory } from './ui';

/**
 * Open Beaver in a separate window.
 * If a window already exists, it will be focused instead.
 */
export function openBeaverWindow(origin?: Window): void {
    BeaverUIFactory.openBeaverWindow(origin);
}
