/**
 * Load the native addons that unit tests use in worker threads once in the
 * main process, and keep them loaded for the whole run.
 *
 * Node unloads an addon's library when the last thread that loaded it exits.
 * Vitest runs each test file in a worker thread and tears it down afterwards,
 * and that teardown can still run the addon's weak-handle callbacks after the
 * library is gone, which kills the run with a segmentation fault. A reference
 * held by the main thread keeps the library mapped.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default function setup(): void {
    require('sharp');
}
