import { describe, it, expect } from 'vitest';
import {
    isBatchProgressStamp,
    selectBatchProgress,
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
