import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    describeAuthError,
    getAuthDiagnostics,
    recordAuthDiagnostic,
    resetAuthDiagnosticsForTesting,
    summarizeStack,
} from '../../../src/services/authDiagnostics';

describe('auth diagnostics', () => {
    beforeEach(() => resetAuthDiagnosticsForTesting());

    it('collapses consecutive repeats so periodic reads cannot push out earlier events', () => {
        recordAuthDiagnostic('restore_failed', 'attempt 1');
        for (let i = 0; i < 200; i++) recordAuthDiagnostic('storage_read_empty');
        const entries = getAuthDiagnostics();
        expect(entries.map((entry) => entry.event)).toEqual(['restore_failed', 'storage_read_empty']);
        expect(entries[1].count).toBe(200);
        expect(entries[1].lastAt).toBeTruthy();
    });

    it('keeps the most recent events and truncates long details', () => {
        for (let i = 0; i < 60; i++) recordAuthDiagnostic('event', String(i));
        recordAuthDiagnostic('long', 'x'.repeat(1000));
        const entries = getAuthDiagnostics();
        expect(entries).toHaveLength(50);
        expect(entries[0].detail).toBe('11');
        expect(entries[49].detail).toHaveLength(300);
    });

    it('returns copies that callers cannot mutate', () => {
        recordAuthDiagnostic('signed_out');
        getAuthDiagnostics()[0].event = 'changed';
        expect(getAuthDiagnostics()[0].event).toBe('signed_out');
    });

    it('describes auth errors by class, status, code and message', () => {
        expect(describeAuthError(Object.assign(new Error('Invalid Refresh Token'), {
            name: 'AuthApiError', status: 400, code: 'refresh_token_not_found',
        }))).toBe('AuthApiError 400 [refresh_token_not_found]: Invalid Refresh Token');
        expect(describeAuthError(Object.assign(new Error('Failed'), { name: 'AuthRetryableFetchError', status: 0 })))
            .toBe('AuthRetryableFetchError: Failed');
        expect(describeAuthError('plain')).toBe('plain');
    });

    it('reduces a stack to function names in both engines', () => {
        const spiderMonkey = [
            'removeItem@chrome://beaver/content/scripts/beaver.js:10:5',
            '@chrome://beaver/content/scripts/beaver.js:11:5',
            'async*_removeSession@chrome://beaver/content/scripts/beaver.js:12:5',
        ].join('\n');
        expect(summarizeStack(spiderMonkey)).toBe('removeItem < async*_removeSession');
        // Bundled closures are named after their module path, `@scope` included.
        const bundled = [
            'createEncryptedStorageAdapter/<.removeItem@chrome://beaver/content/scripts/beaver.js:10:5',
            'node_modules/@supabase/auth-js/dist/module/GoTrueClient.js/_signOut/<@chrome://beaver/content/scripts/beaver.js:20:7',
        ].join('\n');
        expect(summarizeStack(bundled)).toBe('removeItem < _signOut');
        const v8 = [
            'Error: ',
            '    at Object.removeItem (/Users/me/src/storage.ts:1:1)',
            '    at /Users/me/src/anonymous.ts:2:2',
            '    at async _removeSession (/Users/me/node_modules/auth.js:3:3)',
        ].join('\n');
        expect(summarizeStack(v8)).toBe('Object.removeItem < _removeSession');
    });
});
