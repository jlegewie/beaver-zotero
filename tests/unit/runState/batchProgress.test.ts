import { describe, it, expect } from 'vitest';
import {
    batchOutcomeTarget,
    isBatchProgressStamp,
    readBatchProgressStamp,
    selectBatchProgress,
    selectBatchPanelGroups,
    selectLiveBatchProgress,
    selectChainBatchOutcomes,
    selectRunBatchOutcomes,
    selectTrackedBatch,
} from '@beaver/agent-core/run-state/batchProgress';
import type {
    BatchOutcomeBlock,
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

/**
 * A run, still going unless a status says otherwise: an ended batch is live
 * only while the run that finished it is.
 */
function run(
    id: string,
    messages: ModelMessage[],
    status: AgentRun['status'] = 'in_progress',
): AgentRun {
    return { id, status, model_messages: messages } as unknown as AgentRun;
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

    it('rejects a stamp with an unrenderable entry', () => {
        expect(isBatchProgressStamp({ batches: [{ batch_id: 'b1' }] })).toBe(false);
        expect(isBatchProgressStamp({ batches: [null] })).toBe(false);
    });
});

describe('readBatchProgressStamp', () => {
    it('returns null for anything that is not a stamp', () => {
        expect(readBatchProgressStamp(null)).toBeNull();
        expect(readBatchProgressStamp({ batches: 'nope' })).toBeNull();
    });

    it('drops an entry missing the headline the bar renders', () => {
        const value = { batches: [{ batch_id: 'bad' }, entry({ batch_id: 'good' })] };
        expect(readBatchProgressStamp(value)?.batches.map((b) => b.batch_id)).toEqual(['good']);
    });

    it('drops a null entry without exposing it to selectors', () => {
        const value = { batches: [null, entry({ batch_id: 'good' })] };
        const result = readBatchProgressStamp(value);

        expect(result?.batches.map((b) => b.batch_id)).toEqual(['good']);
        expect(() => selectTrackedBatch(result)).not.toThrow();
    });

    it('returns an empty stamp when no entry is renderable', () => {
        const result = readBatchProgressStamp({ batches: [{ batch_id: 'bad' }] });
        expect(result?.batches).toEqual([]);
    });

    it('returns the value itself when every entry is renderable', () => {
        const value = stamp(entry());
        expect(readBatchProgressStamp(value)).toBe(value);
    });
});

describe('records written before blocks existed', () => {
    // Stored threads keep the old shape forever. The read step adapts them once,
    // so nothing downstream has to know there were ever two shapes.
    const legacy = {
        batch_id: 'b1',
        operation: 'sort',
        progress_primary: '40 of 184',
        resolved: 40,
        tally_heading: 'Where items are going',
        tallies: [{ label: 'Ecology', count: 23, reference: 'CHT8AIF6' }],
        tallies_overflow: 3,
        tallies_total: 77,
        removals: [{ label: 'Inbox', count: 31, removal: true }],
        removals_overflow: 2,
        failure_reasons: [{ label: 'No text layer', count: 4 }],
        failure_reasons_overflow: 1,
    };

    const adapted = () => readBatchProgressStamp({ batches: [legacy] })!.batches[0].blocks!;

    it('builds one block per legacy list, in render order', () => {
        expect(adapted().map((b) => b.kind)).toEqual(['destination', 'removal', 'failure']);
    });

    it('carries the rows, overflow and total of each list across', () => {
        const [destination, removal, failure] = adapted();
        expect(destination).toEqual({
            heading: 'Where items are going',
            kind: 'destination',
            rows: legacy.tallies,
            overflow: 3,
            total: 77,
        });
        expect(removal.rows).toEqual(legacy.removals);
        expect(removal.overflow).toBe(2);
        expect(failure.rows).toEqual(legacy.failure_reasons);
        expect(failure.overflow).toBe(1);
    });

    it('supplies the headings the client used to own', () => {
        const [, removal, failure] = adapted();
        expect(removal.heading).toBe('Removed');
        expect(failure.heading).toBe('Could not be read');
    });

    it('leaves an entry that already has blocks alone', () => {
        const modern = entry({ blocks: [{ heading: 'Tags applied', kind: 'destination' }] });
        const read = readBatchProgressStamp({ batches: [modern] })!;
        expect(read.batches[0]).toBe(modern);
    });

    it('adds nothing to an entry with no outcomes in either shape', () => {
        const bare = entry();
        expect(readBatchProgressStamp({ batches: [bare] })!.batches[0]).toBe(bare);
    });

    it('skips a legacy distribution the backend hid with an empty heading', () => {
        // An empty `tally_heading` was how the old shape said "no distribution".
        const hidden = { ...legacy, tally_heading: '' };
        const blocks = readBatchProgressStamp({ batches: [hidden] })!.batches[0].blocks!;
        expect(blocks.map((b) => b.kind)).toEqual(['removal', 'failure']);
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

    it('keeps a readable entry beside an unreadable one', () => {
        // Per-entry, not all-or-nothing: falling back to the older stamp here
        // would show stale numbers for a batch that has since moved.
        const older = stamp(entry({ batch_id: 'b1', progress_primary: '5 of 9' }));
        const mixed = {
            batches: [{ batch_id: 'broken' }, entry({ batch_id: 'b1', progress_primary: '9 of 9' })],
        };
        const result = selectBatchProgress([
            run('r1', [request(older)]),
            run('r2', [request(mixed as never)]),
        ]);
        expect(result?.batches.map((b) => b.progress_primary)).toEqual(['9 of 9']);
    });
});

describe('selectLiveBatchProgress', () => {
    it('returns null when nothing has been stamped', () => {
        expect(selectLiveBatchProgress([run('r1', [request(null)])])).toBeNull();
    });

    it('keeps a batch that ended in the run still going', () => {
        const done = stamp(entry({ status: 'completed', progress_primary: '184 of 184' }));
        const result = selectLiveBatchProgress([run('r1', [request(done)])]);
        expect(result?.batches).toHaveLength(1);
    });

    it.each(['completed', 'error', 'canceled'] as const)(
        'hands an ended batch to the receipt once its run is %s',
        (status) => {
            // Otherwise it would be drawn twice at once: above the composer and,
            // a few lines up, under the run that just ended.
            const done = stamp(entry({ status: 'completed' }));
            const result = selectLiveBatchProgress([run('r1', [request(done)], status)]);
            expect(result?.batches).toEqual([]);
        },
    );

    it('keeps an ended batch while its run holds for an approval', () => {
        // `awaiting_deferred` is not terminal, so the run has not ended and no
        // receipt is drawn for it yet.
        const done = stamp(entry({ status: 'completed' }));
        const result = selectLiveBatchProgress([
            run('r1', [request(done)], 'awaiting_deferred'),
        ]);
        expect(result?.batches).toHaveLength(1);
    });

    it('keeps an ended batch while its carrying run is live, last run or not', () => {
        // The panel gives an ended batch up on exactly the condition the receipt
        // takes it on, so this is the case that would otherwise fall through
        // both: a carrier that is not the newest run and has not finished.
        const done = stamp(entry({ status: 'completed' }));
        const result = selectLiveBatchProgress([
            run('r1', [request(done)], 'in_progress'),
            run('r2', [request(null)]),
        ]);
        expect(result?.batches).toHaveLength(1);
    });

    it.each(['completed', 'error', 'canceled'] as const)(
        'drops an open batch once its run is %s',
        (status) => {
            // Nothing runs when no run is active, so an open batch left by one
            // is paused — the stop that ended the run never got to say so.
            const running = stamp(entry({ progress_primary: '40 of 184' }));
            const result = selectLiveBatchProgress([run('r1', [request(running)], status)]);
            expect(result?.batches).toEqual([]);
        },
    );

    it('keeps an open batch while its run holds for an approval', () => {
        const running = stamp(entry({ progress_primary: '40 of 184' }));
        const result = selectLiveBatchProgress([
            run('r1', [request(running)], 'awaiting_deferred'),
        ]);
        expect(result?.batches).toHaveLength(1);
    });

    it('drops a batch the stamp flags as paused', () => {
        // Its run is live but working something else — an incidental edit on
        // one of the batch's items is what re-stamped it.
        const mixed = stamp(
            entry({ batch_id: 'worked' }),
            entry({ batch_id: 'paused', paused: true }),
        );
        const result = selectLiveBatchProgress([run('r1', [request(mixed)])]);
        expect(result?.batches.map((b) => b.batch_id)).toEqual(['worked']);
    });

    it('draws nothing when every batch in a live run is paused', () => {
        const paused = stamp(entry({ batch_id: 'b1', paused: true }));
        const result = selectLiveBatchProgress([run('r1', [request(paused)])]);
        expect(result?.batches).toEqual([]);
        expect(selectTrackedBatch(result)).toBeNull();
    });

    it('draws a batch again once a later run resumes it', () => {
        const paused = stamp(entry({ batch_id: 'b1', paused: true }));
        const resumed = stamp(entry({ batch_id: 'b1', is_handover: true }));
        const result = selectLiveBatchProgress([
            run('r1', [request(paused)], 'canceled'),
            run('r2', [request(resumed)]),
        ]);
        expect(result?.batches.map((b) => b.batch_id)).toEqual(['b1']);
    });

    it('drops a batch that ended before the newest run started', () => {
        const done = stamp(entry({ status: 'completed' }));
        const result = selectLiveBatchProgress([
            run('r1', [request(done)], 'completed'),
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
                run('r1', [request(ended)], 'completed'),
                run('r2', [request(null)]),
            ]);
            expect(result?.batches).toEqual([]);
        },
    );

    it('does not carry an open batch into later runs', () => {
        // A batch nobody resumed stays paused however many turns follow, so the
        // bar must not sit above the composer for the rest of the thread.
        const running = stamp(entry({ progress_primary: '40 of 184' }));
        const result = selectLiveBatchProgress([
            run('r1', [request(running)], 'completed'),
            run('r2', [request(null)], 'completed'),
            run('r3', [request(null)]),
        ]);
        expect(result?.batches).toEqual([]);
    });

    it('returns the stamp itself when nothing was dropped', () => {
        // Reference equality — a rebuilt stamp would re-render derived atoms.
        const running = stamp(entry());
        const runs = [run('r1', [request(running)])];
        expect(selectLiveBatchProgress(runs)).toBe(selectBatchProgress(runs));
    });

    it('treats a newer run with no messages as having moved on', () => {
        // A run exists as soon as the user sends, before it has streamed anything.
        const done = stamp(entry({ status: 'completed' }));
        const starting = { id: 'r2', status: 'in_progress', model_messages: [] } as unknown as AgentRun;
        const result = selectLiveBatchProgress([run('r1', [request(done)], 'completed'), starting]);
        expect(result?.batches).toEqual([]);
    });
});

describe('selectRunBatchOutcomes', () => {
    it('returns nothing for a run that stamped no batch', () => {
        expect(selectRunBatchOutcomes(run('r1', [request(null)]))).toEqual([]);
    });

    it('returns nothing while every batch of the run is still open', () => {
        const running = stamp(entry({ progress_primary: '40 of 184' }));
        expect(selectRunBatchOutcomes(run('r1', [request(running)]))).toEqual([]);
    });

    it('reports a finished batch in the state it finished in', () => {
        // The run keeps stamping as the batch works; the last record is the one
        // the receipt has to show.
        const started = stamp(entry({ progress_primary: '0 of 184' }));
        const half = stamp(entry({ progress_primary: '92 of 184' }));
        const done = stamp(entry({ status: 'completed', progress_primary: '184 of 184' }));
        const outcomes = selectRunBatchOutcomes(
            run('r1', [request(started), request(half), request(done)]),
        );
        expect(outcomes.map((b) => b.progress_primary)).toEqual(['184 of 184']);
    });

    it.each(['completed', 'failed_out', 'cancelled'] as const)(
        'reports a batch that ended as %s',
        (status) => {
            const outcomes = selectRunBatchOutcomes(run('r1', [request(stamp(entry({ status })))]));
            expect(outcomes).toHaveLength(1);
        },
    );

    it('leaves an open batch to the live panel', () => {
        const mixed = stamp(
            entry({ batch_id: 'done', status: 'completed' }),
            entry({ batch_id: 'open' }),
        );
        const outcomes = selectRunBatchOutcomes(run('r1', [request(mixed)]));
        expect(outcomes.map((b) => b.batch_id)).toEqual(['done']);
    });

    it('keeps a batch the backend judged too small for a progress bar', () => {
        // Opening a batch is the model's decision; a size cutoff here would
        // leave a run that wrote real changes with no record of them.
        const small = stamp(entry({ batch_id: 'small', status: 'completed', show_progress: false }));
        expect(
            selectRunBatchOutcomes(run('r1', [request(small)])).map((b) => b.batch_id),
        ).toEqual(['small']);
    });

    it('lists the most recent completion first, as the panel does', () => {
        // Both stacks cap their rows and keep the ones listed first, so ordering
        // these oldest-first would fold the batch that held the bar a second ago
        // away at the very moment its run ended.
        const first = stamp(
            entry({ batch_id: 'filing', is_handover: true }),
            entry({ batch_id: 'tagging' }),
        );
        const second = stamp(
            entry({ batch_id: 'tagging', is_handover: true, status: 'completed' }),
            entry({ batch_id: 'filing', status: 'completed' }),
        );
        const outcomes = selectRunBatchOutcomes(run('r1', [request(first), request(second)]));
        expect(outcomes.map((b) => b.batch_id)).toEqual(['tagging', 'filing']);
    });

    it('keeps the rows the panel had just shown, either side of the handover', () => {
        // Five batches, the last one finishing on the call that ended the run.
        // The panel's bar was on b5 with b4, b3 under it; the receipt must open
        // on the same three, not on the two nobody has looked at since.
        //
        // Every stamp leads with the handover, this one included, so a batch's
        // place cannot be read off where it first appeared — b5 leads the only
        // stamp there is despite being the last to finish.
        const end = stamp(
            entry({ batch_id: 'b5', is_handover: true, status: 'completed' }),
            ...['b1', 'b2', 'b3', 'b4'].map((batch_id) => entry({ batch_id, status: 'completed' })),
        );
        const outcomes = selectRunBatchOutcomes(run('r1', [request(end)]));
        expect(outcomes.map((b) => b.batch_id)).toEqual(['b5', 'b4', 'b3', 'b2', 'b1']);
    });

    it('reads the newest stamp of a message carrying several', () => {
        const outcomes = selectRunBatchOutcomes(
            run('r1', [
                request(
                    stamp(entry({ progress_primary: '92 of 184' })),
                    stamp(entry({ status: 'completed', progress_primary: '184 of 184' })),
                ),
            ]),
        );
        expect(outcomes.map((b) => b.progress_primary)).toEqual(['184 of 184']);
    });

    it('returns one shared empty list, so a run with no batches never re-renders', () => {
        expect(selectRunBatchOutcomes(run('r1', [request(null)]))).toBe(
            selectRunBatchOutcomes(run('r2', [])),
        );
    });
});

describe('selectChainBatchOutcomes', () => {
    it('reports one run the same way selectRunBatchOutcomes does', () => {
        const only = run('r1', [request(stamp(entry({ status: 'completed' })))], 'completed');
        expect(selectChainBatchOutcomes([only])).toEqual(selectRunBatchOutcomes(only));
    });

    it('gathers the batches of every run of a continued answer', () => {
        const interrupted = run(
            'r1',
            [request(stamp(entry({ batch_id: 'filing', status: 'completed' })))],
            'canceled',
        );
        const continuation = run(
            'r2',
            [request(stamp(entry({ batch_id: 'tagging', status: 'completed' })))],
            'completed',
        );
        const outcomes = selectChainBatchOutcomes([interrupted, continuation]);
        expect(outcomes.map((b) => b.batch_id)).toEqual(['tagging', 'filing']);
    });

    it('keeps the later record of a batch worked across the interruption', () => {
        // The run that was cut off saw the batch at 92; the run that picked it
        // up saw it end. Only the second is the outcome.
        const interrupted = run(
            'r1',
            [request(stamp(entry({ status: 'cancelled', progress_primary: '92 of 184' })))],
            'canceled',
        );
        const continuation = run(
            'r2',
            [request(stamp(entry({ status: 'completed', progress_primary: '184 of 184' })))],
            'completed',
        );
        const outcomes = selectChainBatchOutcomes([interrupted, continuation]);
        expect(outcomes.map((b) => b.progress_primary)).toEqual(['184 of 184']);
    });

    it('drops an older outcome for a batch the continuation reopened', () => {
        // The continuation picked the batch back up and was itself cut off
        // before it ended, so the batch is open again: the panel draws it, and
        // the receipt must not also report the state it was left in before.
        const interrupted = run(
            'r1',
            [request(stamp(entry({ status: 'cancelled', progress_primary: '92 of 184' })))],
            'canceled',
        );
        const continuation = run(
            'r2',
            [request(stamp(entry({ progress_primary: '120 of 184' })))],
            'error',
        );
        expect(selectChainBatchOutcomes([interrupted, continuation])).toEqual([]);
    });

    it('returns one shared empty list, so a chain with no batches never re-renders', () => {
        expect(selectChainBatchOutcomes([run('r1', [request(null)]), run('r2', [])])).toBe(
            selectChainBatchOutcomes([]),
        );
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

    it('tracks the flagged batch whatever size the backend judged it', () => {
        const result = selectTrackedBatch(
            stamp(
                entry({ batch_id: 'small', show_progress: false, is_handover: true }),
                entry({ batch_id: 'big' }),
            ),
        );
        expect(result?.batch_id).toBe('small');
    });

    it('tracks a lone small batch rather than drawing nothing', () => {
        expect(
            selectTrackedBatch(stamp(entry({ batch_id: 'b1', show_progress: false })))?.batch_id,
        ).toBe('b1');
    });
});

describe('selectBatchPanelGroups', () => {
    it('has nothing to draw without a stamp', () => {
        expect(selectBatchPanelGroups(null)).toEqual({ tracked: null, done: [], queued: [] });
    });

    it('tracks the batch being worked and queues the rest in work order', () => {
        const groups = selectBatchPanelGroups(
            stamp(
                entry({ batch_id: 'b2', is_handover: true }),
                entry({ batch_id: 'b3' }),
                entry({ batch_id: 'b4' }),
            ),
        );
        expect(groups.tracked?.batch_id).toBe('b2');
        expect(groups.queued.map((e) => e.batch_id)).toEqual(['b3', 'b4']);
        expect(groups.done).toEqual([]);
    });

    it('keeps a batch that has ended instead of dropping it', () => {
        const groups = selectBatchPanelGroups(
            stamp(
                entry({ batch_id: 'open', is_handover: true }),
                entry({ batch_id: 'ended', status: 'completed' }),
            ),
        );
        expect(groups.done.map((e) => e.batch_id)).toEqual(['ended']);
        expect(groups.queued).toEqual([]);
    });

    it.each(['completed', 'failed_out', 'cancelled'] as const)(
        'counts a %s batch as done',
        (status) => {
            const groups = selectBatchPanelGroups(
                stamp(entry({ batch_id: 'open', is_handover: true }), entry({ batch_id: 'x', status })),
            );
            expect(groups.done.map((e) => e.batch_id)).toEqual(['x']);
        },
    );

    it('puts the most recent completion nearest the bar', () => {
        // The stamp lists the handover batch first, then the rest in the order
        // they were created — and batches are worked oldest-first.
        const groups = selectBatchPanelGroups(
            stamp(
                entry({ batch_id: 'open', is_handover: true }),
                entry({ batch_id: 'first', status: 'completed' }),
                entry({ batch_id: 'second', status: 'completed' }),
            ),
        );
        expect(groups.done.map((e) => e.batch_id)).toEqual(['second', 'first']);
    });

    it('leads with the batch that ended on this very call', () => {
        // The backend pins the handover flag at the top of the request and does
        // not clear it when that batch ends, so an ended handover leads the
        // stamp while having finished AFTER the batches listed behind it.
        const groups = selectBatchPanelGroups(
            stamp(
                entry({ batch_id: 'just-ended', status: 'completed', is_handover: true }),
                entry({ batch_id: 'ended-first', status: 'completed' }),
                entry({ batch_id: 'ended-second', status: 'completed' }),
                entry({ batch_id: 'open' }),
            ),
        );
        expect(groups.tracked?.batch_id).toBe('open');
        expect(groups.done.map((e) => e.batch_id)).toEqual([
            'just-ended',
            'ended-second',
            'ended-first',
        ]);
    });

    it('tracks the open batch even when an ended one is flagged as the handover', () => {
        // A stamp can flag a batch as the handover on the call that ends it;
        // tracking that one would hide the batch actually being worked.
        const groups = selectBatchPanelGroups(
            stamp(
                entry({ batch_id: 'ended', status: 'completed', is_handover: true }),
                entry({ batch_id: 'open' }),
            ),
        );
        expect(groups.tracked?.batch_id).toBe('open');
        expect(groups.done.map((e) => e.batch_id)).toEqual(['ended']);
    });

    it('still gives the full bar to the last batch when every one has ended', () => {
        const groups = selectBatchPanelGroups(
            stamp(
                entry({ batch_id: 'b1', status: 'completed', is_handover: true }),
                entry({ batch_id: 'b2', status: 'completed' }),
            ),
        );
        expect(groups.tracked?.batch_id).toBe('b1');
        expect(groups.done.map((e) => e.batch_id)).toEqual(['b2']);
    });

    it('groups every batch in the stamp, whatever its size', () => {
        const groups = selectBatchPanelGroups(
            stamp(
                entry({ batch_id: 'big', is_handover: true }),
                entry({ batch_id: 'small', status: 'completed', show_progress: false }),
            ),
        );
        expect(groups.tracked?.batch_id).toBe('big');
        expect(groups.done.map((e) => e.batch_id)).toEqual(['small']);
    });
});

describe('tally rows', () => {
    it('carries a destination name and its key apart', () => {
        // The backend composes the name from the `collection_names` this client
        // returns during action validation, and splits the composed label back
        // into halves — so no surface here resolves a key.
        const row = { label: 'Ecology', count: 23, reference: 'CHT8AIF6' };
        const result = selectTrackedBatch(
            stamp(
                entry({
                    blocks: [{ heading: 'Where items are going', kind: 'destination', rows: [row] }],
                }),
            ),
        );
        expect(result?.blocks?.[0].rows?.[0].label).toBe('Ecology');
        expect(result?.blocks?.[0].rows?.[0].reference).toBe('CHT8AIF6');
    });

    it('leaves a label with no identity behind it alone', () => {
        // A tag or a field name is its own identity; only `sort` has a key.
        const result = selectTrackedBatch(
            stamp(
                entry({
                    blocks: [
                        {
                            heading: 'Tags applied',
                            kind: 'destination',
                            rows: [{ label: 'machine learning', count: 41 }],
                        },
                    ],
                }),
            ),
        );
        expect(result?.blocks?.[0].rows?.[0].reference).toBeUndefined();
    });
});

describe('batchOutcomeTarget', () => {
    const block = (
        kind: BatchOutcomeBlock['kind'],
        rows: BatchOutcomeBlock['rows'],
    ): BatchOutcomeBlock => ({ heading: 'Heading', kind, rows });

    it('names the collection a sort row filed items into', () => {
        expect(
            batchOutcomeTarget(
                'sort',
                block('destination', [{ label: 'Ecology', count: 4, reference: 'CHT8AIF6' }]),
                { label: 'Ecology', count: 4, reference: 'CHT8AIF6' },
            ),
        ).toEqual({ kind: 'collection', key: 'CHT8AIF6', name: 'Ecology' });
    });

    it('names nothing for a sort row that carries no key', () => {
        // Name without a key cannot address a collection.
        const row = { label: 'Ecology', count: 4 };
        expect(batchOutcomeTarget('sort', block('destination', [row]), row)).toBeNull();
    });

    it('names the tag a tag row applied', () => {
        const row = { label: 'methods', count: 12 };
        expect(batchOutcomeTarget('tag', block('destination', [row]), row)).toEqual({
            kind: 'tag',
            name: 'methods',
        });
    });

    it('names nothing on a removal row', () => {
        const row = { label: 'Inbox', count: 2, reference: 'CHT8AIF6' };
        expect(batchOutcomeTarget('sort', block('removal', [row]), row)).toBeNull();
    });

    it('names nothing on a failure row', () => {
        const row = { label: 'No text layer', count: 3 };
        expect(batchOutcomeTarget('extract', block('failure', [row]), row)).toBeNull();
    });

    it('carries the batch library so a tag names the one it was applied in', () => {
        const row = { label: 'methods', count: 12 };
        expect(batchOutcomeTarget('tag', block('destination', [row]), row, 'g900')).toEqual({
            kind: 'tag',
            name: 'methods',
            libraryRef: 'g900',
        });
    });

    it('carries it for a collection too', () => {
        const row = { label: 'Ecology', count: 4, reference: 'CHT8AIF6' };
        expect(batchOutcomeTarget('sort', block('destination', [row]), row, 'u')).toEqual({
            kind: 'collection',
            key: 'CHT8AIF6',
            name: 'Ecology',
            libraryRef: 'u',
        });
    });

    it('leaves the library undefined when the batch named none', () => {
        // A batch spanning libraries sends no ref, and an empty string is the
        // same absence once it has been through the wire's omit-empty pass.
        const row = { label: 'methods', count: 12 };
        for (const ref of [undefined, '', '  ']) {
            expect(batchOutcomeTarget('tag', block('destination', [row]), row, ref))
                .toEqual({ kind: 'tag', name: 'methods', libraryRef: undefined });
        }
    });

    it('names nothing for an operation that tallies by something else', () => {
        // Field names, not library objects. Unknown operations stay null too.
        const row = { label: 'Publisher', count: 8 };
        expect(batchOutcomeTarget('edit_metadata', block('destination', [row]), row)).toBeNull();
        expect(batchOutcomeTarget('brand_new_operation', block('destination', [row]), row)).toBeNull();
    });
});
