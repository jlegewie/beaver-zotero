import { describe, expect, it } from 'vitest';

import {
    isFatalWasmError,
    isHeapExhaustionError,
    isRecoverablePageError,
} from '../../../src/beaver-extract/wasmFatal';

describe('isHeapExhaustionError', () => {
    it('matches MuPDF heap allocation failures', () => {
        expect(isHeapExhaustionError(new Error('malloc (1024 bytes) failed'))).toBe(true);
        expect(isHeapExhaustionError(new Error('realloc 2048 failed'))).toBe(true);
        expect(isHeapExhaustionError(new Error('calloc (32 x 64 bytes) failed'))).toBe(true);
        expect(isHeapExhaustionError(new Error('out of memory'))).toBe(true);
        expect(isHeapExhaustionError(new RuntimeErrorLike('Cannot enlarge memory arrays'))).toBe(true);
        expect(isHeapExhaustionError(new RuntimeErrorLike('Aborted(OOM)'))).toBe(true);
    });

    it('does not match ordinary WASM traps', () => {
        expect(isHeapExhaustionError(new RuntimeErrorLike('memory access out of bounds'))).toBe(false);
        expect(isHeapExhaustionError(new Error('unreachable executed'))).toBe(false);
        expect(isHeapExhaustionError(new Error('table index is out of bounds'))).toBe(false);
    });
});

describe('isFatalWasmError', () => {
    it('matches traps that poison the MuPDF WASM instance', () => {
        expect(isFatalWasmError(new RuntimeErrorLike('memory access out of bounds'))).toBe(true);
        expect(isFatalWasmError(new Error('unreachable executed'))).toBe(true);
        expect(isFatalWasmError(new Error('table index is out of bounds'))).toBe(true);
        expect(isFatalWasmError(new Error('call stack exhausted'))).toBe(true);
        expect(isFatalWasmError(new RangeError('Maximum call stack size exceeded'))).toBe(true);
        expect(isFatalWasmError(new Error('stack overflow'))).toBe(true);
    });

    it('does not match ordinary extraction failures', () => {
        expect(isFatalWasmError(new Error('Document is encrypted'))).toBe(false);
        expect(isFatalWasmError({ name: 'ExtractionError', code: 'NO_TEXT_LAYER' })).toBe(false);
    });

    it('classifies RuntimeError-shaped heap exhaustion as non-fatal', () => {
        const err = new RuntimeErrorLike('Aborted(OOM)');
        expect(isHeapExhaustionError(err)).toBe(true);
        expect(isFatalWasmError(err)).toBe(false);
    });

    it('still classifies genuine RuntimeError traps as fatal', () => {
        expect(isFatalWasmError(new Error('RuntimeError: memory access out of bounds'))).toBe(true);
    });
});

describe('isRecoverablePageError', () => {
    it('treats malformed-page-tree errors as recoverable (skip the page)', () => {
        expect(isRecoverablePageError(new Error('cannot find page 22 in page tree'))).toBe(true);
        expect(isRecoverablePageError(new Error('non-page object in page tree'))).toBe(true);
        expect(isRecoverablePageError(new Error('malformed page tree'))).toBe(true);
        expect(isRecoverablePageError(new Error('cycle in page tree'))).toBe(true);
    });

    it('treats WASM traps as non-recoverable (must abort)', () => {
        expect(isRecoverablePageError(new RuntimeErrorLike('memory access out of bounds'))).toBe(false);
        expect(isRecoverablePageError(new Error('call stack exhausted'))).toBe(false);
    });

    it('treats heap exhaustion as non-recoverable', () => {
        expect(isRecoverablePageError(new Error('malloc (1024 bytes) failed'))).toBe(false);
    });

    it('does NOT swallow non-page-tree failures — they must surface, not silently drop a page', () => {
        // A corrupt content stream failing later in page processing is a real
        // extraction failure, not a skippable unresolvable leaf.
        expect(isRecoverablePageError(new Error('Failed to create structured text'))).toBe(false);
        expect(isRecoverablePageError(new SyntaxError('Unexpected token in JSON'))).toBe(false);
        expect(isRecoverablePageError(new Error('Document is encrypted'))).toBe(false);
    });
});

class RuntimeErrorLike extends Error {
    name = 'RuntimeError';
}
