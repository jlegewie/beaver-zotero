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

export async function setup(): Promise<void> {
    await requireNamedInstance();
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
