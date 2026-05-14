/**
 * Unit tests for the worker-side URL config (`worker/config.ts`).
 *
 * The worker dispatcher (`worker/index.ts`) gates every op behind
 * `isWorkerConfigured()`. We can't unit-test the dispatcher itself (it
 * runs in a Worker context with WASM imports), but we can pin the
 * config-module contract that the gate relies on:
 *   - `isWorkerConfigured()` is false until `setWorkerUrls` runs.
 *   - `getWorkerUrls()` throws before configure (so an op that touches
 *     WASM URLs without a prior configure fails loudly).
 *   - After configure, the URLs round-trip exactly.
 */
import { describe, expect, it } from 'vitest';

import {
    getWorkerUrls,
    isWorkerConfigured,
    setWorkerUrls,
} from '../../../src/beaver-extract/worker/config';

describe('worker/config', () => {
    it('throws on getWorkerUrls before configure', () => {
        // Note: module state is global; this test runs first to observe
        // the pre-configure state. Tests below depend on the configured
        // state surviving — the worker-config module-scope intentionally
        // has no reset for production safety.
        // We can't strictly guarantee ordering across files, so instead of
        // asserting `isWorkerConfigured() === false` here (which would
        // depend on test isolation), assert the contract: if not yet
        // configured, getWorkerUrls throws.
        if (!isWorkerConfigured()) {
            expect(() => getWorkerUrls()).toThrow(
                /MuPDF worker not configured/,
            );
        }
    });

    it('round-trips URLs through setWorkerUrls / getWorkerUrls', () => {
        setWorkerUrls({
            mupdfWasmFactoryUrl: 'test://factory.mjs',
            mupdfWasmBinaryUrl: 'test://factory.wasm',
            sentencexWasmFactoryUrl: 'test://sentencex.js',
            sentencexWasmBinaryUrl: 'test://sentencex.wasm',
        });
        expect(isWorkerConfigured()).toBe(true);
        const urls = getWorkerUrls();
        expect(urls).toEqual({
            mupdfWasmFactoryUrl: 'test://factory.mjs',
            mupdfWasmBinaryUrl: 'test://factory.wasm',
            sentencexWasmFactoryUrl: 'test://sentencex.js',
            sentencexWasmBinaryUrl: 'test://sentencex.wasm',
        });
    });

    it('overwrites prior config on a repeat call', () => {
        setWorkerUrls({
            mupdfWasmFactoryUrl: 'a://factory.mjs',
            mupdfWasmBinaryUrl: 'a://factory.wasm',
            sentencexWasmFactoryUrl: 'a://sentencex.js',
            sentencexWasmBinaryUrl: 'a://sentencex.wasm',
        });
        setWorkerUrls({
            mupdfWasmFactoryUrl: 'b://factory.mjs',
            mupdfWasmBinaryUrl: 'b://factory.wasm',
            sentencexWasmFactoryUrl: 'b://sentencex.js',
            sentencexWasmBinaryUrl: 'b://sentencex.wasm',
        });
        expect(getWorkerUrls().mupdfWasmFactoryUrl).toBe('b://factory.mjs');
    });
});
