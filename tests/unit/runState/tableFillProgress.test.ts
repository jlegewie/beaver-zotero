import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStore } from 'jotai/vanilla';
import type { WSTableFillStarted } from '@beaver/agent-core/protocol/tableCardProtocol';
import {
    addTableFillProgressAtom,
    clearTableFillProgressAtom,
    fillRemainingMs,
    fillRowsDone,
    formatRemaining,
    recordFillCommit,
    recordTableFillCommitAtom,
    removeTableFillProgressAtom,
    startFillProgress,
    tableFillProgressAtom,
} from '@beaver/agent-core/run-state/tableFillProgress';

const stamp: WSTableFillStarted = JSON.parse(
    readFileSync(join(__dirname, '../../fixtures/artifacts/table-tool-outcomes.json'), 'utf8'),
).fill_stamp;

const commit = (rows: string[], failed: string[] = [], extra = {}) => ({
    table: stamp.table.key,
    run_id: stamp.run_id,
    rows,
    failed_rows: failed,
    ...extra,
});

describe('table fill progress', () => {
    it('counts the rows the commits wrote, once each, against the stamp\'s total', () => {
        let progress = startFillProgress(stamp, 0);
        expect(fillRowsDone(progress)).toBe(0);
        progress = recordFillCommit(progress, commit(['r1', 'r2', 'r3'], ['r3']), 1000);
        progress = recordFillCommit(progress, commit(['r3', 'r4']), 2000);
        expect(fillRowsDone(progress)).toBe(4);
        // r3 was answered again without a failure.
        expect(progress.failedRows).toEqual([]);
        expect(progress.updatedAt).toBe(2000);
    });

    it('ignores commits to another table or from another run', () => {
        const progress = startFillProgress(stamp, 0);
        expect(recordFillCommit(progress, commit(['r1'], [], { table: 'u-OTHERTAB' }), 1)).toBe(progress);
        expect(recordFillCommit(progress, commit(['r1'], [], { run_id: 'another-run' }), 1)).toBe(progress);
        expect(recordFillCommit(progress, commit([]), 1)).toBe(progress);
    });

    it('estimates the time left from the pace so far', () => {
        let progress = startFillProgress(stamp, 0);
        expect(fillRemainingMs(progress)).toBeNull();
        // 7 of 14 rows in 70 seconds: 70 seconds to go.
        progress = recordFillCommit(progress, commit(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 70_000);
        expect(fillRemainingMs(progress)).toBe(70_000);
        expect(formatRemaining(fillRemainingMs(progress))).toBe('about 1 min left');
        expect(formatRemaining(20_000)).toBe('under a minute left');
        expect(formatRemaining(95 * 60_000)).toBe('about 1 h 35 min left');
        expect(formatRemaining(null)).toBeNull();
    });

    it('keeps one entry per tool call, retired by its return or a clear', () => {
        const store = createStore();
        store.set(addTableFillProgressAtom, stamp);
        store.set(recordTableFillCommitAtom, commit(['r1']));
        expect(store.get(tableFillProgressAtom).get(stamp.toolcall_id)?.rows).toEqual(['r1']);
        store.set(removeTableFillProgressAtom, 'another-call');
        expect(store.get(tableFillProgressAtom).size).toBe(1);
        store.set(removeTableFillProgressAtom, stamp.toolcall_id);
        expect(store.get(tableFillProgressAtom).size).toBe(0);
        store.set(addTableFillProgressAtom, stamp);
        store.set(clearTableFillProgressAtom);
        expect(store.get(tableFillProgressAtom).size).toBe(0);
    });
});
