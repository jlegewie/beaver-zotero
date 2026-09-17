/**
 * The batch receipt a terminal run keeps in the transcript.
 *
 * Kept beside the rest of the batch UI tests rather than under the run view:
 * the receipt is the completed rows of `batchDoneRows.test.ts` in their second
 * home, and the two are read together.
 *
 * Driven through a hook stand-in rather than mounted — same approach as
 * `batchDoneRows.test.ts` (jsdom is not loaded). Which batches a run reports is
 * `selectRunBatchOutcomes`' decision, covered in
 * `tests/unit/runState/batchProgress.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

const { hookState } = vi.hoisted(() => ({
    hookState: { slots: [] as any[], index: 0 },
}));

vi.mock('react', async () => {
    const actual = await vi.importActual<any>('react');

    const slot = <T,>(initial: () => T): { value: T } => {
        const i = hookState.index++;
        if (hookState.slots.length <= i) hookState.slots[i] = { value: initial() };
        return hookState.slots[i];
    };

    const hooks = {
        useState: (initial: any) => {
            const cell = slot(() => (typeof initial === 'function' ? initial() : initial));
            return [cell.value, (next: any) => {
                cell.value = typeof next === 'function' ? next(cell.value) : next;
            }];
        },
        useRef: (initial: any) => slot(() => ({ current: initial })).value,
        useCallback: (fn: any) => fn,
        useMemo: (fn: any) => fn(),
        useEffect: () => {},
    };

    return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import React from 'react';
import type { BatchProgressEntry, BatchProgressStamp } from '@beaver/agent-core/run-state/batchProgress';
import type { AgentRun, ModelMessage } from '@beaver/agent-core/agents/types';
import { BatchRunReceipt } from '@beaver/agent-ui/chat/BatchRunReceipt';

function entry(overrides: Partial<BatchProgressEntry> = {}): BatchProgressEntry {
    return {
        batch_id: 'b1',
        operation: 'sort',
        progress_primary: '184 of 184',
        show_progress: true,
        status: 'completed',
        ...overrides,
    };
}

function stamp(...batches: BatchProgressEntry[]): BatchProgressStamp {
    return { batches };
}

function request(value: BatchProgressStamp | null): ModelMessage {
    return {
        kind: 'request',
        run_id: 'r1',
        instructions: '',
        parts: [
            {
                part_kind: 'tool-return',
                tool_name: 'organize_items',
                tool_call_id: 'call-0',
                content: {},
                metadata: value ? { batch_progress: value } : {},
            },
        ],
    } as unknown as ModelMessage;
}

function run(
    messages: ModelMessage[],
    status: AgentRun['status'] = 'completed',
    id = 'r1',
): AgentRun {
    return { id, status, model_messages: messages } as unknown as AgentRun;
}

/** Every string rendered, joined — what the user actually reads. */
function renderedText(node: React.ReactNode, out: string[] = []): string[] {
    if (typeof node === 'string') {
        out.push(node);
        return out;
    }
    if (Array.isArray(node)) {
        node.forEach((child) => renderedText(child, out));
        return out;
    }
    if (!React.isValidElement(node)) return out;
    const element = node as React.ReactElement<any>;
    if (typeof element.type === 'function') {
        renderedText((element.type as (props: any) => React.ReactNode)(element.props), out);
        return out;
    }
    renderedText(element.props.children ?? null, out);
    return out;
}

function render(messages: ModelMessage[]): string {
    return renderChain([run(messages)]);
}

/** The receipt for a whole answer: one run, or a chain oldest first. */
function renderChain(runs: AgentRun[]): string {
    hookState.slots = [];
    hookState.index = 0;
    return renderedText(BatchRunReceipt({ runs }) as React.ReactNode).join(' ');
}

describe('the batch receipt under a terminal run', () => {
    it('renders nothing for a run that finished no batch', () => {
        expect(BatchRunReceipt({ runs: [run([request(null)])] })).toBeNull();
    });

    it('renders nothing for a run whose batch is still open', () => {
        const running = stamp(entry({ status: undefined, progress_primary: '40 of 184' }));
        expect(BatchRunReceipt({ runs: [run([request(running)])] })).toBeNull();
    });

    it.each(['in_progress', 'awaiting_deferred'] as const)(
        'renders nothing while the run is %s, so the panel keeps its batches',
        (status) => {
            // The live panel is drawing these; drawing them here too would put
            // the same batch on screen twice, a few lines apart.
            hookState.slots = [];
            hookState.index = 0;
            const done = stamp(entry({ progress_title: 'Filed items' }));
            expect(BatchRunReceipt({ runs: [run([request(done)], status)] })).toBeNull();
        },
    );

    it('draws the same batch once its run is terminal', () => {
        // The other half of the handover: nothing else about the run changed.
        const done = stamp(entry({ progress_title: 'Filed items' }));
        expect(render([request(done)])).toContain('Filed items');
    });

    it('states what each finished batch did', () => {
        const text = render([
            request(
                stamp(
                    entry({ batch_id: 'filing', progress_title: 'Filed items' }),
                    entry({
                        batch_id: 'tagging',
                        progress_title: 'Tagged items',
                        progress_primary: '96 of 96',
                    }),
                ),
            ),
        ]);
        expect(text).toContain('Filed items');
        expect(text).toContain('184 of 184');
        expect(text).toContain('Tagged items');
        expect(text).toContain('96 of 96');
    });

    it('keeps the failures the live bar stated', () => {
        const text = render([
            request(stamp(entry({ progress_title: 'Read attachments', failed: 7, status: 'failed_out' }))),
        ]);
        expect(text).toContain('7 failed');
    });

    it('shows every batch the run finished, hiding none behind a disclosure', () => {
        // The overflow line is itself a row, so folding one batch away saves no
        // height and costs a click. The composer strip pays for its rows; the
        // transcript does not.
        const text = render([
            request(
                stamp(
                    entry({ batch_id: 'd', progress_title: 'Edited fields', is_handover: true }),
                    entry({ batch_id: 'a', progress_title: 'Filed items' }),
                    entry({ batch_id: 'b', progress_title: 'Tagged items' }),
                    entry({ batch_id: 'c', progress_title: 'Read attachments' }),
                ),
            ),
        ]);
        expect(text).toContain('Edited fields');
        expect(text).toContain('Read attachments');
        expect(text).toContain('Tagged items');
        expect(text).toContain('Filed items');
        expect(text).not.toContain('more completed');
    });

    it('reports the batches of every run an interrupted answer took', () => {
        // The chain reads as one message and carries one receipt, under its
        // last run — a batch the interrupted run finished belongs in it too.
        const text = renderChain([
            run([request(stamp(entry({ batch_id: 'filing', progress_title: 'Filed items' })))], 'canceled', 'r1'),
            run([request(stamp(entry({ batch_id: 'tagging', progress_title: 'Tagged items' })))], 'completed', 'r2'),
        ]);
        expect(text).toContain('Filed items');
        expect(text).toContain('Tagged items');
    });

    it('names items from the record written where the batch started, even in an earlier answer', () => {
        // The population record rides on `batch_start`; a batch that ends
        // after an ordinary follow-up message ends under a later chain than
        // the one it started in. The names are looked up across the thread,
        // while the batches drawn stay those this answer finished.
        const started: ModelMessage = {
            kind: 'request',
            run_id: 'r1',
            instructions: '',
            parts: [
                {
                    part_kind: 'tool-return',
                    tool_name: 'batch_start',
                    tool_call_id: 'call-start',
                    content: {},
                    metadata: { batch_population: { batch_id: 'filing', items: [{ id: 'u-A', n: 'Smith 2004' }] } },
                },
            ],
        } as unknown as ModelMessage;
        const earlier = run([started], 'completed', 'r1');
        const ending = run([request(stamp(entry({ batch_id: 'filing', progress_title: 'Filed items' })))], 'completed', 'r2');

        hookState.slots = [];
        hookState.index = 0;
        const receipt = BatchRunReceipt({ runs: [ending], historyRuns: [earlier, ending] }) as React.ReactElement<any>;
        const rows = receipt.props.children;
        expect(rows.props.batches.map((b: BatchProgressEntry) => b.batch_id)).toEqual(['filing']);
        expect(rows.props.populationsByBatch.get('filing')?.get('u-A')?.n).toBe('Smith 2004');

        // Without the thread, only the answer's own runs are searched.
        hookState.slots = [];
        hookState.index = 0;
        const alone = BatchRunReceipt({ runs: [ending] }) as React.ReactElement<any>;
        expect(alone.props.children.props.populationsByBatch.size).toBe(0);
    });

    it('keeps the records for an answer whose run the thread does not hold yet', () => {
        // A run that failed or was stopped stays in the active slot until the
        // next send, so it is not in the thread; the records written before
        // it are still what its receipt needs.
        const started: ModelMessage = {
            kind: 'request',
            run_id: 'r1',
            instructions: '',
            parts: [
                {
                    part_kind: 'tool-return',
                    tool_name: 'batch_start',
                    tool_call_id: 'call-start',
                    content: {},
                    metadata: { batch_population: { batch_id: 'filing', items: [{ id: 'u-A', n: 'Smith 2004' }] } },
                },
            ],
        } as unknown as ModelMessage;
        const earlier = run([started], 'completed', 'r1');
        const failed = run([request(stamp(entry({ batch_id: 'filing', progress_title: 'Filed items', status: 'failed_out' })))], 'error', 'r2');

        hookState.slots = [];
        hookState.index = 0;
        const receipt = BatchRunReceipt({ runs: [failed], historyRuns: [earlier] }) as React.ReactElement<any>;
        expect(receipt.props.children.props.populationsByBatch.get('filing')?.get('u-A')?.n).toBe('Smith 2004');
    });

    it('recovers the outcome record of a batch a later answer only restated', () => {
        // The record is written once, where the batch ended. An answer that
        // updates the finished batch's goal states it again without the
        // record, so the receipt reaches back for it — but not forward: a
        // record written after this answer describes a newer state.
        const recordFor = (label: string): ModelMessage =>
            ({
                kind: 'request',
                run_id: 'r',
                instructions: '',
                parts: [
                    {
                        part_kind: 'tool-return',
                        tool_name: 'batch_resolve',
                        tool_call_id: 'call-items',
                        content: {},
                        metadata: {
                            batch_items: { batches: [{ batch_id: 'filing', groups: [{ kind: 'finding', label, item_ids: ['u-A'] }] }] },
                        },
                    },
                ],
            }) as unknown as ModelMessage;
        const ended = run([recordFor('recorded when it ended')], 'completed', 'r1');
        const restated = run([request(stamp(entry({ batch_id: 'filing', progress_title: 'Filed items' })))], 'completed', 'r2');
        const later = run([recordFor('recorded after this answer')], 'completed', 'r3');

        hookState.slots = [];
        hookState.index = 0;
        const receipt = BatchRunReceipt({ runs: [restated], historyRuns: [ended, restated, later] }) as React.ReactElement<any>;
        const items = receipt.props.children.props.itemsByBatch;
        expect(items.get('filing')?.groups[0].label).toBe('recorded when it ended');
    });

    it('says what each batch was for, so two of one operation are told apart', () => {
        // Titles come from the operation, not the batch: two `edit_metadata`
        // batches are both "Edited items", and only the goal distinguishes them.
        const text = render([
            request(
                stamp(
                    entry({
                        batch_id: 'dois',
                        progress_title: 'Edited items',
                        progress_primary: '216 of 216',
                        goal: 'Find DOIs for items missing them',
                    }),
                    entry({
                        batch_id: 'abstracts',
                        progress_title: 'Edited items',
                        progress_primary: '267 of 267',
                        goal: 'Add abstracts where they are missing',
                    }),
                ),
            ),
        ]);
        expect(text).toContain('Find DOIs for items missing them');
        expect(text).toContain('Add abstracts where they are missing');
    });
});

describe('the item records the thread carries', () => {
    it('hands each finished batch its record', () => {
        hookState.slots = [];
        hookState.index = 0;
        const message = {
            kind: 'request',
            run_id: 'r1',
            instructions: '',
            parts: [
                {
                    part_kind: 'tool-return',
                    tool_name: 'batch_resolve',
                    tool_call_id: 'call-0',
                    content: {},
                    metadata: {
                        batch_progress: stamp(entry({ progress_title: 'Reviewed items' })),
                        batch_items: {
                            batches: [{ batch_id: 'b1', groups: [{ kind: 'finding', label: 'no PDF', item_ids: ['u-A'] }] }],
                        },
                    },
                },
            ],
        } as unknown as ModelMessage;
        const tree = BatchRunReceipt({ runs: [run([message])] }) as React.ReactElement<any>;
        const rows = React.Children.toArray(tree.props.children)[0] as React.ReactElement<any>;
        expect(rows.props.itemsByBatch.get('b1')?.groups).toEqual([{ kind: 'finding', label: 'no PDF', item_ids: ['u-A'] }]);
    });

    it('hands nothing for a thread written before records existed', () => {
        hookState.slots = [];
        hookState.index = 0;
        const tree = BatchRunReceipt({ runs: [run([request(stamp(entry()))])] }) as React.ReactElement<any>;
        const rows = React.Children.toArray(tree.props.children)[0] as React.ReactElement<any>;
        expect(rows.props.itemsByBatch.size).toBe(0);
    });
});
