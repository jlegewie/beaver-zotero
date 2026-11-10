import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded: vi.fn((id: number) => (id === 9 ? { message: 'Library 9 is excluded (model wording)' } : null)),
}));
vi.mock('../../../src/utils/libraryMessages', () => ({
    excludedLibraryUserMessage: vi.fn(() => 'This library is excluded from Beaver.'),
}));

import {
    actionError,
    assertLibraryNotExcluded,
    toExecuteResponse,
    unboundedExecutionContext,
} from '../../../src/services/agentDataProvider/actions/actionExecution';
import { checkAborted, TimeoutError } from '../../../src/services/agentDataProvider/timeout';
import { getUserFacingErrorMessage } from '../../../src/utils/userFacingError';

describe('toExecuteResponse', () => {
    it('wraps the result as a successful response', async () => {
        const response = await toExecuteResponse('r1', 'test', async () => ({ items_modified: 2 }));
        expect(response).toEqual({
            type: 'agent_action_execute_response',
            request_id: 'r1',
            success: true,
            result_data: { items_modified: 2 },
        });
    });

    it('reports an expected failure with its code and candidates', async () => {
        const response = await toExecuteResponse('r2', 'test', async () => {
            throw actionError('old_string_not_found', 'Not found', {
                userMessage: 'Card wording',
                errorCandidates: [{ snippet: 'near miss' } as any],
            });
        });
        expect(response).toMatchObject({
            success: false,
            error: 'Not found',
            error_code: 'old_string_not_found',
            error_candidates: [{ snippet: 'near miss' }],
        });
    });

    it('reports an unexpected error by its message and own code, or execution_failed', async () => {
        const coded = await toExecuteResponse('r3', 'test', async () => {
            throw Object.assign(new Error('Library gone'), { code: 'library_unavailable' });
        });
        expect(coded).toMatchObject({ success: false, error: 'Library gone', error_code: 'library_unavailable' });

        const plain = await toExecuteResponse('r4', 'test', async () => { throw new Error('boom'); });
        expect(plain).toMatchObject({ success: false, error: 'boom', error_code: 'execution_failed' });
    });

    it('lets a timeout through for the request handler to answer', async () => {
        await expect(toExecuteResponse('r5', 'test', async () => { throw new TimeoutError(25, 26000, 'save'); }))
            .rejects.toBeInstanceOf(TimeoutError);
    });
});

it('attaches timing to either outcome', async () => {
    const timing = { total_ms: 0 };
    const ok = await toExecuteResponse('r6', 'test', async () => { timing.total_ms = 5; return {}; }, () => timing);
    expect(ok).toMatchObject({ success: true, timing: { total_ms: 5 } });
    const failed = await toExecuteResponse('r7', 'test', async () => { throw new Error('boom'); }, () => ({ total_ms: 7 }));
    expect(failed).toMatchObject({ success: false, timing: { total_ms: 7 } });
});

describe('unboundedExecutionContext', () => {
    it('never times out, however long the apply runs', () => {
        const ctx = unboundedExecutionContext();
        ctx.startTime -= 24 * 60 * 60 * 1000;
        expect(() => checkAborted(ctx, 'save')).not.toThrow();
    });
});

describe('assertLibraryNotExcluded', () => {
    it('refuses an excluded library with model wording, card wording and a code', () => {
        let thrown: unknown;
        try {
            assertLibraryNotExcluded(9);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toMatchObject({ code: 'library_not_searchable', message: 'Library 9 is excluded (model wording)' });
        expect(getUserFacingErrorMessage(thrown, 'fallback')).toBe('This library is excluded from Beaver.');
    });

    it('allows a library that is not excluded', () => {
        expect(() => assertLibraryNotExcluded(1)).not.toThrow();
    });
});
