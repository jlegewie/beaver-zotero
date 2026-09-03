import { describe, expect, it } from 'vitest';
import { inlineNullParams } from '../../../src/services/database';
import { parseQueryAndParams } from '../../mocks/zoteroQueryParams';

describe('inlineNullParams', () => {
    it('leaves a query without null parameters untouched', () => {
        const sql = `UPDATE t SET a = ? WHERE b = ?`;
        expect(inlineNullParams(sql, [1, 2])).toEqual([sql, [1, 2]]);
    });

    it('splices NULL into the placeholder that owns it, whatever its position', () => {
        const [sql, params] = inlineNullParams(
            `UPDATE t SET a = ?, b = CASE WHEN ? THEN ? ELSE b END
             WHERE c = ? AND d IS ? AND e IS ?`,
            [null, 1, 'x', 7, null, 'keep'],
        );
        expect(sql).toBe(
            `UPDATE t SET a = NULL, b = CASE WHEN ? THEN ? ELSE b END
             WHERE c = ? AND d IS NULL AND e IS ?`,
        );
        expect(params).toEqual([1, 'x', 7, 'keep']);
    });

    it('ignores question marks inside string literals and comments', () => {
        const [sql, params] = inlineNullParams(
            `UPDATE t SET a = '???', b = ? -- why?\n WHERE c IS ? /* or ? */`,
            ['v', null],
        );
        expect(sql).toBe(`UPDATE t SET a = '???', b = ? -- why?\n WHERE c IS NULL /* or ? */`);
        expect(params).toEqual(['v']);
    });

    it('leaves undefined bound so Zotero still rejects it', () => {
        const [, params] = inlineNullParams(`UPDATE t SET a = ?, b = ?`, [undefined, null]);
        expect(params).toEqual([undefined]);
    });

    it('rejects a parameter count that does not match the placeholders', () => {
        expect(() => inlineNullParams(`UPDATE t SET a = ?`, [null, null])).toThrow(
            /Incorrect number of parameters/,
        );
    });

    it('rejects numbered placeholders rather than mis-assigning them', () => {
        expect(() => inlineNullParams(`UPDATE t SET a = ?1, b = ?1`, [null])).toThrow(
            /Numbered SQL placeholders are not supported/,
        );
    });

    it('produces statements Zotero passes through unchanged', () => {
        // The point of the helper: Zotero's own null handling cannot see
        // `IS ?` placeholders, so it must never be given a null to handle.
        const original = `UPDATE t SET a = ?, b = CASE WHEN ? THEN ? ELSE b END
             WHERE c = ? AND d IS ? AND e IS ?`;
        expect(() => parseQueryAndParams(original, [null, 1, 'x', 7, null, 'keep'])).toThrow(
            /Null parameter provided for a query without placeholders/,
        );

        const [sql, params] = inlineNullParams(original, [null, 1, 'x', 7, null, 'keep']);
        expect(parseQueryAndParams(sql, params)).toEqual([sql, params]);
    });
});
