/**
 * Shared utility for checking whether a live Zotero instance is available.
 *
 * Used by both live and integration tests to gracefully skip when Zotero
 * is not running.
 */

import { ZOTERO_PORT_CANDIDATES, setZoteroPort } from './fixtures';

let zoteroAvailable: boolean | null = null;

async function probePort(port: number): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(
            `http://127.0.0.1:${port}/beaver/test/ping`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
                signal: controller.signal,
            },
        );
        clearTimeout(timer);
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Check if Zotero is running and the Beaver plugin is loaded.
 * Probes each candidate port in `ZOTERO_PORT_CANDIDATES` (env var first, then
 * 23119, then 23124) and stores the first hit so subsequent helpers use the
 * right base URL. Result is cached for the lifetime of the test process.
 */
export async function isZoteroAvailable(): Promise<boolean> {
    if (zoteroAvailable !== null) return zoteroAvailable;
    for (const port of ZOTERO_PORT_CANDIDATES) {
        if (await probePort(port)) {
            setZoteroPort(port);
            zoteroAvailable = true;
            return true;
        }
    }
    zoteroAvailable = false;
    return false;
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
