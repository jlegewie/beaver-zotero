import { describe, expect, it } from 'vitest';

import { isFatalWasmError } from '../../../src/beaver-extract/wasmFatal';

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
});

class RuntimeErrorLike extends Error {
    name = 'RuntimeError';
}
