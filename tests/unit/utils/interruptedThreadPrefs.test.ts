/**
 * The preference record that carries an interrupted chat across a restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    getInterruptedThreads,
    takeInterruptedThread,
    saveInterruptedThread,
} from '../../../src/utils/interruptedThreadPrefs';

const PREF_KEY = 'extensions.zotero.beaver.interruptedThread';

/** Preference store backing `Zotero.Prefs`, so save/read round-trips for real. */
let prefs: Record<string, unknown>;

beforeEach(() => {
    vi.clearAllMocks();
    // The staleness cutoff is measured against the wall clock, so pin it —
    // otherwise the fixed timestamps below age out as the calendar moves.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    prefs = {};
    vi.mocked(Zotero.Prefs.get).mockImplementation((key: string) => prefs[key] as any);
    vi.mocked(Zotero.Prefs.set).mockImplementation((key: string, value: any) => {
        prefs[key] = value;
        return value;
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('interrupted thread record', () => {
    it('round-trips the thread it was given', () => {
        saveInterruptedThread({
            threadId: 'thread-1',
            userId: 'user-1',
            threadName: 'Protein folding',
            closedAt: '2026-08-20T10:00:00.000Z',
        });

        expect((getInterruptedThreads()[0] ?? null)).toEqual({
            threadId: 'thread-1',
            userId: 'user-1',
            threadName: 'Protein folding',
            closedAt: '2026-08-20T10:00:00.000Z',
        });
    });

    it('stamps the current time when the caller gives none', () => {
        saveInterruptedThread({ threadId: 'thread-1', userId: 'user-1', threadName: null });

        expect((getInterruptedThreads()[0] ?? null)?.closedAt).toBe('2026-08-20T12:00:00.000Z');
    });

    it('offers the most recent interruption first', () => {
        saveInterruptedThread({ threadId: 'thread-1', userId: 'user-1', threadName: 'First' });
        saveInterruptedThread({ threadId: 'thread-2', userId: 'user-1', threadName: 'Second' });

        expect((getInterruptedThreads()[0] ?? null)?.threadId).toBe('thread-2');
    });

    it('reads nothing once cleared', () => {
        saveInterruptedThread({ threadId: 'thread-1', userId: 'user-1', threadName: null });
        prefs[PREF_KEY] = "";

        expect((getInterruptedThreads()[0] ?? null)).toBeNull();
    });

    it('reads nothing when no interruption was recorded', () => {
        expect((getInterruptedThreads()[0] ?? null)).toBeNull();
    });

    it('ignores a record that aged out', () => {
        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
        saveInterruptedThread({
            threadId: 'thread-1',
            userId: 'user-1',
            threadName: 'Stale',
            closedAt: eightDaysAgo,
        });

        expect((getInterruptedThreads()[0] ?? null)).toBeNull();
    });

    it('keeps a record from within the last week', () => {
        const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
        saveInterruptedThread({
            threadId: 'thread-1',
            userId: 'user-1',
            threadName: 'Recent',
            closedAt: sixDaysAgo,
        });

        expect((getInterruptedThreads()[0] ?? null)?.threadId).toBe('thread-1');
    });

    it.each([
        ['unparseable JSON', 'not json'],
        ['a non-object', '"thread-1"'],
        ['a record with no thread id', '{"userId":"user-1","closedAt":"2026-08-20T10:00:00.000Z"}'],
        ['a record with no account', '{"threadId":"thread-1","closedAt":"2026-08-20T10:00:00.000Z"}'],
        ['a record with no timestamp', '{"threadId":"thread-1","userId":"user-1"}'],
        ['an unparseable timestamp', '{"threadId":"thread-1","userId":"user-1","closedAt":"whenever"}'],
    ])('ignores %s', (_label, stored) => {
        prefs[PREF_KEY] = stored;

        expect((getInterruptedThreads()[0] ?? null)).toBeNull();
    });

    it('tolerates a missing thread name', () => {
        prefs[PREF_KEY] = '{"threadId":"thread-1","userId":"user-1","closedAt":"2026-08-20T10:00:00.000Z"}';

        expect((getInterruptedThreads()[0] ?? null)).toEqual({
            threadId: 'thread-1',
            userId: 'user-1',
            threadName: null,
            closedAt: '2026-08-20T10:00:00.000Z',
        });
    });

    it('does not throw when the preference write fails', () => {
        vi.mocked(Zotero.Prefs.set).mockImplementation(() => {
            throw new Error('prefs unavailable');
        });

        // Neither writer may throw: one runs in a shutdown handler, the other
        // in the effect that consumes the record.
        expect(() =>
            saveInterruptedThread({ threadId: 'thread-1', userId: 'user-1', threadName: null }),
        ).not.toThrow();
        expect(() => takeInterruptedThread("user-1")).not.toThrow();
    });
});

describe('interrupted run list', () => {
    it('preserves other accounts pending records when presenting an offer', () => {
        saveInterruptedThread({ threadId: 'a', userId: 'user-a', threadName: null });
        saveInterruptedThread({ threadId: 'b', userId: 'user-b', threadName: null });
        expect(takeInterruptedThread('user-b')?.threadId).toBe('b');
        expect(getInterruptedThreads()).toHaveLength(2);
        expect(takeInterruptedThread('user-a')?.threadId).toBe('a');
        expect(takeInterruptedThread('user-a')).toBeNull();
        expect(takeInterruptedThread('user-b')).toBeNull();
    });
    it('deduplicates by account, thread and run and presents each only once', () => {
        const record = { threadId: 't', runId: 'r1', userId: 'u', threadName: null };
        saveInterruptedThread(record); saveInterruptedThread(record);
        saveInterruptedThread({ ...record, runId: 'r2' });
        expect(getInterruptedThreads()).toHaveLength(2);
        expect(takeInterruptedThread('u')?.runId).toBe('r2');
        expect(takeInterruptedThread('u')?.runId).toBe('r1');
        expect(takeInterruptedThread('u')).toBeNull();
        saveInterruptedThread(record);
        expect(takeInterruptedThread('u')).toBeNull();
    });
    it("bounds persisted records and never offers another account's chat", () => {
        for (let index = 0; index < 30; index++) saveInterruptedThread({ threadId: String(index), runId: String(index), userId: 'u', threadName: null });
        expect(getInterruptedThreads()).toHaveLength(20);
        expect(takeInterruptedThread('other')).toBeNull();
        expect(takeInterruptedThread('u')?.threadId).toBe('29');
    });
});
