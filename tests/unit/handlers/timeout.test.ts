import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    MAX_PDF_TIMEOUT_SECONDS,
    TimeoutError,
    createTimeoutController,
} from '../../../src/services/agentDataProvider/timeout';

describe('createTimeoutController', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('falls back to the default for non-positive or non-finite values', () => {
        const zero = createTimeoutController(0, 30);
        const infinite = createTimeoutController(Number.POSITIVE_INFINITY, 30);

        expect(zero.timeoutSeconds).toBe(30);
        expect(infinite.timeoutSeconds).toBe(30);

        zero.dispose();
        infinite.dispose();
    });

    it('accepts fractional positive values', () => {
        const timeout = createTimeoutController(0.25, 30);

        expect(timeout.timeoutSeconds).toBe(0.25);

        timeout.dispose();
    });

    it('clamps oversized values to the PDF timeout ceiling', () => {
        const timeout = createTimeoutController(999, 30);

        expect(timeout.timeoutSeconds).toBe(MAX_PDF_TIMEOUT_SECONDS);

        timeout.dispose();
    });

    it('throws TimeoutError after the deadline aborts', () => {
        vi.useFakeTimers();
        const timeout = createTimeoutController(1, 30);

        vi.advanceTimersByTime(1000);

        expect(() => timeout.throwIfTimedOut('test_phase')).toThrow(TimeoutError);
        expect(() => timeout.throwIfTimedOut('test_phase')).toThrow(
            /Operation timed out after 1 seconds/,
        );

        timeout.dispose();
    });

    it('uses the main window AbortController when the current global has none', () => {
        const originalAbortController = globalThis.AbortController;
        const mainWindow = { AbortController: originalAbortController };
        vi.spyOn(Zotero, 'getMainWindow').mockReturnValue(mainWindow as any);
        Object.defineProperty(globalThis, 'AbortController', {
            value: undefined,
            configurable: true,
            writable: true,
        });

        try {
            const timeout = createTimeoutController(1, 30);

            expect(timeout.signal).toBeInstanceOf(AbortSignal);
            expect(Zotero.getMainWindow).toHaveBeenCalled();

            timeout.dispose();
        } finally {
            Object.defineProperty(globalThis, 'AbortController', {
                value: originalAbortController,
                configurable: true,
                writable: true,
            });
        }
    });
});
