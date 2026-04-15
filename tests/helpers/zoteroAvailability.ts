/**
 * Shared utility for checking whether a live Zotero instance is available.
 *
 * Used by both live and integration tests to gracefully skip when Zotero
 * is not running.
 */

import { ZOTERO_PORT } from './fixtures';

let zoteroAvailable: boolean | null = null;

/**
 * Check if Zotero is running and the Beaver plugin is loaded.
 * Result is cached for the lifetime of the test process.
 */
export async function isZoteroAvailable(): Promise<boolean> {
    if (zoteroAvailable !== null) return zoteroAvailable;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(
            `http://127.0.0.1:${ZOTERO_PORT}/beaver/test/ping`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
                signal: controller.signal,
            },
        );
        clearTimeout(timer);
        zoteroAvailable = res.ok;
    } catch {
        zoteroAvailable = false;
    }
    return zoteroAvailable;
}

/**
 * Call in `beforeEach` to skip the current test if Zotero is not available.
 *
 * Usage:
 * ```ts
 * let available: boolean;
 * beforeAll(async () => { available = await isZoteroAvailable(); });
 * beforeEach((ctx) => { skipIfNoZotero(ctx, available); });
 * ```
 */
export function skipIfNoZotero(ctx: any, available: boolean): void {
    if (!available) ctx.skip();
}
