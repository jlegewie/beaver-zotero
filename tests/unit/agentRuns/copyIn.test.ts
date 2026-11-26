/**
 * What a window passes to a session is copied into the session's realm; what
 * the session already holds keeps its identity.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { copyIn } from '../../../src/services/agentRuns/copyIn';

/** A value built in another realm, as a window builds one. */
const foreign = <T>(source: string): T => runInNewContext(`(${source})`) as T;

describe('values a window passes to a session', () => {
    it('are rebuilt from this realm\'s objects, arrays, maps, sets and dates', () => {
        const value = foreign<any>(`{
            run: { id: 'run-1', parts: [{ text: 'a' }] },
            approvals: new Map([['a1', { id: 'a1' }]]),
            ids: new Set(['x']),
            at: new Date(5),
        }`);
        const copied = copyIn(value);
        expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
        expect(Array.isArray(copied.run.parts) && Object.getPrototypeOf(copied.run.parts)).toBe(Array.prototype);
        expect(copied.approvals).toBeInstanceOf(Map);
        expect(copied.approvals.get('a1')).toEqual({ id: 'a1' });
        expect(Object.getPrototypeOf(copied.approvals.get('a1'))).toBe(Object.prototype);
        expect(copied.ids).toBeInstanceOf(Set);
        expect(copied.at).toBeInstanceOf(Date);
        expect(copied.at.getTime()).toBe(5);
        expect(copied).toEqual({ run: { id: 'run-1', parts: [{ text: 'a' }] }, approvals: new Map([['a1', { id: 'a1' }]]), ids: new Set(['x']), at: new Date(5) });
    });

    it('keep the session\'s own state inside them, identity included', () => {
        const held = { id: 'run-0', parts: [] };
        const build = runInNewContext('(held) => ({ runs: [held, { id: "run-1" }] })') as (held: object) => { runs: object[] };
        const copied = copyIn(build(held));
        expect(copied.runs[0]).toBe(held);
        expect(Object.getPrototypeOf(copied.runs[1])).toBe(Object.prototype);
    });

    it('are kept as they are when they are this realm\'s already', () => {
        const value = { a: [1, 2], b: new Map() };
        expect(copyIn(value)).toBe(value);
        expect(copyIn('text')).toBe('text');
        expect(copyIn(null)).toBeNull();
    });

    it('keep shared and cyclic structure', () => {
        const value = foreign<any>(`(() => { const shared = { n: 1 }; const root = { a: shared, b: shared }; root.self = root; return root; })()`);
        const copied = copyIn(value);
        expect(copied.a).toBe(copied.b);
        expect(copied.self).toBe(copied);
    });
});
