/**
 * Vitest `setupFiles` entry for the live and integration suites.
 *
 * `globalSetup` clears the excluded-libraries set once per run, but the set
 * lives in the running Zotero and any test file may leave one behind — a suite
 * that excludes a library and then fails before its teardown poisons every file
 * that runs after it, usually as a wall of `library_excluded` errors far from
 * the file that caused them. Re-normalizing at the start of each file keeps a
 * leak contained to the file that produced it.
 *
 * Registering the hook here (rather than in each suite) means it runs before
 * every test file's own `beforeAll`, so suites that capture the exclusion set
 * to restore it later capture the already-normalized one.
 */

import { beforeAll } from 'vitest';

import { clearExclusions } from './liveExclusions';

beforeAll(async () => {
    await clearExclusions();
}, 30000);
