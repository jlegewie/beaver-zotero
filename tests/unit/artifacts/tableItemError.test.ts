import { expect, it } from 'vitest';
import { isTableItemError, TableItemError } from '../../../src/services/artifacts/tableItemIdentity';

it('recognizes table errors from another bundle without relying on constructor identity', () => {
    const foreign = { name: 'TableItemError', code: 'operation_pending', message: 'Creation is pending' };
    expect(foreign instanceof TableItemError).toBe(false);
    expect(isTableItemError(foreign)).toBe(true);
    expect(isTableItemError(new Error('ordinary failure'))).toBe(false);
    expect(isTableItemError({ name: 'TableItemError', code: 4 })).toBe(false);
});
