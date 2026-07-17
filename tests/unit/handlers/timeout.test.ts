import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ExternalAbortError,
    MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS,
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

    it('clamps to a caller-provided ceiling and leaves in-budget values alone', () => {
        const clamped = createTimeoutController(
            MAX_PDF_TIMEOUT_SECONDS,
            30,
            undefined,
            MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS,
        );
        const within = createTimeoutController(
            45,
            30,
            undefined,
            MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS,
        );

        expect(clamped.timeoutSeconds).toBe(MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS);
        expect(within.timeoutSeconds).toBe(45);

        clamped.dispose();
        within.dispose();
    });

    it('clamps an oversized default with a caller-provided ceiling', () => {
        const timeout = createTimeoutController(
            undefined,
            MAX_PDF_TIMEOUT_SECONDS,
            undefined,
            MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS,
        );

        expect(timeout.timeoutSeconds).toBe(MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS);

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

    it('relays an external abort and surfaces it as ExternalAbortError', () => {
        const external = new AbortController();
        const timeout = createTimeoutController(60, 30, external.signal);

        expect(timeout.signal.aborted).toBe(false);
        external.abort();
        expect(timeout.signal.aborted).toBe(true);
        expect(() => timeout.throwIfTimedOut('test_phase')).toThrow(ExternalAbortError);

        timeout.dispose();
    });

    it('aborts immediately when the external signal is already aborted at construction', () => {
        const external = new AbortController();
        external.abort();
        const timeout = createTimeoutController(60, 30, external.signal);

        expect(timeout.signal.aborted).toBe(true);
        expect(() => timeout.throwIfTimedOut('test_phase')).toThrow(ExternalAbortError);

        timeout.dispose();
    });

    it('still raises TimeoutError when the deadline fires without an external abort', () => {
        vi.useFakeTimers();
        const external = new AbortController();
        const timeout = createTimeoutController(1, 30, external.signal);

        vi.advanceTimersByTime(1000);

        expect(() => timeout.throwIfTimedOut('test_phase')).toThrow(TimeoutError);

        timeout.dispose();
    });

    it('dispose detaches the external abort listener', () => {
        const external = new AbortController();
        const timeout = createTimeoutController(60, 30, external.signal);
        timeout.dispose();
        // After dispose, aborting the external signal should NOT abort
        // the controller's signal (listener was removed).
        external.abort();
        expect(timeout.signal.aborted).toBe(false);
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
