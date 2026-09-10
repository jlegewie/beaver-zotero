/**
 * Vitest `globalSetup` for the live and integration suites.
 *
 * Runs once per run, before any test file: clears Beaver's excluded-libraries
 * set so the fixtures' libraries are all readable, and restores the original
 * set in teardown. See `liveExclusions.ts` for why this is needed.
 */

import { ZOTERO_PORT_CANDIDATES, ZOTERO_PORT_IS_EXPLICIT } from './fixtures';
import {
    clearExclusions,
    describeExclusions,
    restoreExclusions,
    type ExclusionSnapshot,
} from './liveExclusions';
import { post } from './zoteroHttpClient';
import { isZoteroAvailable } from './zoteroAvailability';

let snapshot: ExclusionSnapshot = null;

/**
 * Fail the run when a named instance isn't answering.
 *
 * Every live suite skips itself when Zotero is unreachable, so a run against a
 * dead instance reports "N skipped" and exits 0 — a green result that proves
 * nothing, and the easiest way to believe a broken branch is fine. That
 * forgiving behavior is right when nobody named an instance (a developer
 * running `npm test`-adjacent commands without Zotero), but `ZOTERO_HTTP_PORT`
 * is an assertion that a specific instance is there, so silence is an error.
 *
 * The usual causes are the plugin still booting, being logged out, or having
 * just hot-reloaded: `/beaver/test/*` is registered by the React bundle and
 * gated on authentication, so editing source mid-run can deregister it.
 */
async function requireNamedInstance(): Promise<void> {
    if (!ZOTERO_PORT_IS_EXPLICIT) return;
    if (await isZoteroAvailable()) return;
    const port = ZOTERO_PORT_CANDIDATES[0];
    throw new Error(
        `ZOTERO_HTTP_PORT=${port} was set but http://127.0.0.1:${port}/beaver/test/ping `
        + `did not answer, so every test would silently skip.\n`
        + `  - Is that instance running? (scripts/worktree-ready.sh <branch>)\n`
        + `  - Is Beaver logged in? The dev endpoints live in the React bundle and are\n`
        + `    registered only once the plugin is authenticated.\n`
        + `  - Did a source edit hot-reload the plugin mid-run? Let it settle, then re-run.`,
    );
}

/**
 * Fail the run when the instance has more main windows open than the suites expect.
 *
 * Each main window evaluates its own renderer, so `/beaver/test/*` handlers that
 * still resolve their window with `Zotero.getMainWindow()` can drive one window
 * while reading another window's atoms. The mismatch surfaces as a plausible but
 * wrong value — a stale attachment, an unchanged tab — far from its cause, rather
 * than as an error. Refuse to start instead of reporting that as a product failure.
 *
 * `BEAVER_MULTI_WINDOW_TEST=1` opts in, for the suites that need two windows.
 * A build without the endpoint, or an instance that cannot answer, is left alone:
 * only a positive reading of extra windows stops the run.
 */
async function requireExpectedWindowCount(): Promise<void> {
    if (process.env.BEAVER_MULTI_WINDOW_TEST === '1') return;
    if (!(await isZoteroAvailable())) return;

    let windows: Array<{ id: string; status: string }>;
    try {
        ({ windows } = await post<{ windows: Array<{ id: string; status: string }> }>(
            '/beaver/test/window-runtime',
            { command: 'list' },
            { timeout: 5000 },
        ));
    } catch {
        return;
    }
    if (!Array.isArray(windows) || windows.length <= 1) return;

    throw new Error(
        `${windows.length} main Zotero windows are open, but the live suites assume one.\n`
        + `Dev endpoints are owned by the window that registered last, while some still act\n`
        + `on Zotero.getMainWindow(), so tab and reader assertions can read the wrong window\n`
        + `and fail as if the code were broken.\n`
        + `  - Close the extra windows and re-run.\n`
        + `  - Set BEAVER_MULTI_WINDOW_TEST=1 to run the suites that want two windows.`,
    );
}

export async function setup(): Promise<void> {
    await requireNamedInstance();
    await requireExpectedWindowCount();
    snapshot = await clearExclusions();
    if (snapshot) {
        console.warn(
            `\n[live-setup] Temporarily re-enabled excluded libraries for this run: `
            + `${describeExclusions(snapshot)}.\n`
            + `            The change is in-memory only and is restored when the run ends.\n`,
        );
    }
}

export async function teardown(): Promise<void> {
    await restoreExclusions(snapshot);
    snapshot = null;
}
