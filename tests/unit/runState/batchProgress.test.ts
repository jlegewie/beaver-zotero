import { describe, it, expect } from 'vitest';
import {
    isBatchProgressStamp,
    selectBatchProgress,
    selectLiveBatchProgress,
    selectTrackedBatch,
} from '@beaver/agent-core/run-state/batchProgress';
import type {
    BatchProgressEntry,
    BatchProgressStamp,
} from '@beaver/agent-core/run-state/batchProgress';
import type { AgentRun, ModelMessage } from '@beaver/agent-core/agents/types';

function entry(overrides: Partial<BatchProgressEntry> = {}): BatchProgressEntry {
    return {
        batch_id: 'b1',
        operation: 'sort',
        progress_primary: '40 of 184',
        show_progress: true,
        ...overrides,
    };
}

function stamp(...batches: BatchProgressEntry[]): BatchProgressStamp {
    return { batches };
}

/** A request message carrying tool returns, optionally stamped. */
function request(...stamps: (BatchProgressStamp | null)[]): ModelMessage {
    return {
        kind: 'request',
        run_id: 'r1',
        instructions: '',
        parts: stamps.map((value, index) => ({
            part_kind: 'tool-return',
            tool_name: 'organize_items',
            tool_call_id: `call-${index}`,
            content: {},
            metadata: value ? { batch_progress: value } : {},
        })),
    } as unknown as ModelMessage;
}

function run(id: string, messages: ModelMessage[]): AgentRun {
    return { id, model_messages: messages } as unknown as AgentRun;
}

describe('isBatchProgressStamp', () => {
    it('accepts a stamp with the fields a bar needs', () => {
        expect(isBatchProgressStamp(stamp(entry()))).toBe(true);
    });

    it('accepts an empty batch list', () => {
        expect(isBatchProgressStamp({ batches: [] })).toBe(true);
    });

    it('rejects anything that is not a batch list', () => {
        expect(isBatchProgressStamp(null)).toBe(false);
        expect(isBatchProgressStamp({})).toBe(false);
        expect(isBatchProgressStamp({ batches: 'nope' })).toBe(false);
    });

    it('rejects an entry missing the headline the bar renders', () => {
        expect(isBatchProgressStamp({ batches: [{ batch_id: 'b1' }] })).toBe(false);
    });
});

describe('selectBatchProgress', () => {
    it('returns null when nothing has been stamped', () => {
        expect(selectBatchProgress([run('r1', [request(null)])])).toBeNull();
    });

    it('returns null for a thread with no runs', () => {
        expect(selectBatchProgress([])).toBeNull();
    });

    it('takes the newest stamp in the newest run', () => {
        const older = stamp(entry({ progress_primary: '10 of 184' }));
        const newer = stamp(entry({ progress_primary: '90 of 184' }));
        const result = selectBatchProgress([
            run('r1', [request(older)]),
            run('r2', [request(newer)]),
        ]);
        expect(result?.batches[0].progress_primary).toBe('90 of 184');
    });

    it('prefers a later message within one run', () => {
        const older = stamp(entry({ progress_primary: '10 of 184' }));
        const newer = stamp(entry({ progress_primary: '90 of 184' }));
        const result = selectBatchProgress([run('r1', [request(older), request(newer)])]);
        expect(result?.batches[0].progress_primary).toBe('90 of 184');
    });

    it('prefers a later part within one message', () => {
        // Parallel tool calls land in one message; the last one written is the
        // one that saw the most credits.
        const older = stamp(entry({ progress_primary: '10 of 184' }));
        const newer = stamp(entry({ progress_primary: '90 of 184' }));
        const result = selectBatchProgress([run('r1', [request(older, newer)])]);
        expect(result?.batches[0].progress_primary).toBe('90 of 184');
    });

    it('falls back to an older run when the newest carries no stamp', () => {
        const older = stamp(entry({ progress_primary: '10 of 184' }));
        const result = selectBatchProgress([
            run('r1', [request(older)]),
            run('r2', [request(null)]),
        ]);
        expect(result?.batches[0].progress_primary).toBe('10 of 184');
    });

    it('does not merge older stamps into the newest', () => {
        // A stamp is a complete statement of every batch open when it was
        // written, so merging would resurrect batches that have since ended.
        const older = stamp(entry({ batch_id: 'b1' }), entry({ batch_id: 'b2' }));
        const newer = stamp(entry({ batch_id: 'b1' }));
        const result = selectBatchProgress([run('r1', [request(older), request(newer)])]);
        expect(result?.batches.map((b) => b.batch_id)).toEqual(['b1']);
    });

    it('lets an empty stamp supersede a populated one', () => {
        // Cancelling the last batch writes an EMPTY record rather than none:
        // unrelated tool returns omit the field entirely, so writing nothing
        // would leave the previous stamp standing and bring the cancelled bar
        // back on the next reload.
        const running = stamp(entry({ batch_id: 'b1' }));
        const cancelled: BatchProgressStamp = { batches: [] };
        const result = selectBatchProgress([
            run('r1', [request(running)]),
            run('r2', [request(cancelled)]),
        ]);
        expect(result).not.toBeNull();
        expect(result!.batches).toEqual([]);
        expect(selectTrackedBatch(result)).toBeNull();
    });

    it('skips a run with no messages', () => {
        const only = stamp(entry());
        const empty = { id: 'r2', model_messages: [] } as unknown as AgentRun;
        expect(selectBatchProgress([run('r1', [request(only)]), empty])).not.toBeNull();
    });

    it('ignores a malformed stamp rather than returning it', () => {
        const bad = { kind: 'request', run_id: 'r1', instructions: '', parts: [
            { part_kind: 'tool-return', tool_name: 'x', tool_call_id: 'c', content: {},
              metadata: { batch_progress: { batches: 'nope' } } },
        ] } as unknown as ModelMessage;
        const good = stamp(entry({ progress_primary: '5 of 9' }));
        const result = selectBatchProgress([run('r1', [request(good), bad])]);
        expect(result?.batches[0].progress_primary).toBe('5 of 9');
    });
});

describe('selectLiveBatchProgress', () => {
    it('returns null when nothing has been stamped', () => {
        expect(selectLiveBatchProgress([run('r1', [request(null)])])).toBeNull();
    });

    it('keeps a batch that ended in the newest run', () => {
        const done = stamp(entry({ status: 'completed', progress_primary: '184 of 184' }));
        const result = selectLiveBatchProgress([run('r1', [request(done)])]);
        expect(result?.batches).toHaveLength(1);
    });

    it('drops a batch that ended before the newest run started', () => {
        const done = stamp(entry({ status: 'completed' }));
        const result = selectLiveBatchProgress([
            run('r1', [request(done)]),
            run('r2', [request(null)]),
        ]);
        expect(result?.batches).toEqual([]);
        expect(selectTrackedBatch(result)).toBeNull();
    });

    it.each(['completed', 'failed_out', 'cancelled'] as const)(
        'retires a %s batch once a later run exists',
        (status) => {
            const ended = stamp(entry({ status }));
            const result = selectLiveBatchProgress([
                run('r1', [request(ended)]),
                run('r2', [request(null)]),
            ]);
            expect(result?.batches).toEqual([]);
        },
    );

    it('keeps an active batch across later runs', () => {
        const running = stamp(entry({ progress_primary: '40 of 184' }));
        const result = selectLiveBatchProgress([
            run('r1', [request(running)]),
            run('r2', [request(null)]),
            run('r3', [request(null)]),
        ]);
        expect(result?.batches[0].progress_primary).toBe('40 of 184');
    });

    it('keeps the open batches of a stamp and drops only the ended ones', () => {
        const mixed = stamp(
            entry({ batch_id: 'done', status: 'completed' }),
            entry({ batch_id: 'open' }),
        );
        const result = selectLiveBatchProgress([
            run('r1', [request(mixed)]),
            run('r2', [request(null)]),
        ]);
        expect(result?.batches.map((b) => b.batch_id)).toEqual(['open']);
    });

    it('returns the stamp itself when nothing was dropped', () => {
        // Reference equality — a rebuilt stamp would re-render derived atoms.
        const running = stamp(entry());
        const runs = [run('r1', [request(running)]), run('r2', [request(null)])];
        expect(selectLiveBatchProgress(runs)).toBe(selectBatchProgress(runs));
    });

    it('treats a newer run with no messages as having moved on', () => {
        // A run exists as soon as the user sends, before it has streamed anything.
        const done = stamp(entry({ status: 'completed' }));
        const starting = { id: 'r2', model_messages: [] } as unknown as AgentRun;
        const result = selectLiveBatchProgress([run('r1', [request(done)]), starting]);
        expect(result?.batches).toEqual([]);
    });
});

describe('selectTrackedBatch', () => {
    it('returns null without a stamp', () => {
        expect(selectTrackedBatch(null)).toBeNull();
    });

    it('picks the batch being worked', () => {
        const result = selectTrackedBatch(
            stamp(entry({ batch_id: 'b1' }), entry({ batch_id: 'b2', is_handover: true })),
        );
        expect(result?.batch_id).toBe('b2');
    });

    it('falls back to the first shown batch when none is flagged', () => {
        const result = selectTrackedBatch(stamp(entry({ batch_id: 'b1' }), entry({ batch_id: 'b2' })));
        expect(result?.batch_id).toBe('b1');
    });

    it('ignores batches the backend said are too small to show', () => {
        const result = selectTrackedBatch(
            stamp(
                entry({ batch_id: 'small', show_progress: false, is_handover: true }),
                entry({ batch_id: 'big' }),
            ),
        );
        expect(result?.batch_id).toBe('big');
    });

    it('returns null when every batch is below the threshold', () => {
        expect(
            selectTrackedBatch(stamp(entry({ batch_id: 'b1', show_progress: false }))),
        ).toBeNull();
    });
});

describe('tally rows', () => {
    it('carries a destination name and its key apart', () => {
        // The backend composes the name from the `collection_names` this client
        // returns during action validation, and splits the composed label back
        // into halves — so no surface here resolves a key.
        const tally = { label: 'Ecology', count: 23, reference: 'CHT8AIF6' };
        const result = selectTrackedBatch(stamp(entry({ tallies: [tally] })));
        expect(result?.tallies?.[0].label).toBe('Ecology');
        expect(result?.tallies?.[0].reference).toBe('CHT8AIF6');
    });

    it('leaves a label with no identity behind it alone', () => {
        // A tag or a field name is its own identity; only `sort` has a key.
        const result = selectTrackedBatch(
            stamp(entry({ tallies: [{ label: 'machine learning', count: 41 }] })),
        );
        expect(result?.tallies?.[0].reference).toBeUndefined();
    });
});
