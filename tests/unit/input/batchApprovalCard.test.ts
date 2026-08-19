/**
 * The batch approval card: its one-decision guard and what it renders.
 *
 * Exactly one decision may leave the client: the run correlates on the
 * approval id and a second one arrives after the backend has stopped
 * listening. The card is still mounted and still enabled in the instant after
 * the decision goes out, so two controls can fire before React re-renders with
 * them disabled.
 *
 * The card uses hooks, and this repo's jsdom environment does not currently
 * load, so it is driven here through a minimal hook stand-in rather than
 * mounted: the component function itself is the code under test, and a render
 * is one call to it. The stand-in deliberately does NOT re-render on a state
 * write, which is exactly the situation the guard exists for — every handler
 * of one render sees that render's state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hook slots for the single card instance under test. Hoisted because the
// module mock below is hoisted above the imports.
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
            const setState = (next: any) => {
                cell.value = typeof next === 'function' ? next(cell.value) : next;
            };
            return [cell.value, setState];
        },
        useRef: (initial: any) => slot(() => ({ current: initial })).value,
        useCallback: (fn: any) => fn,
        useEffect: () => {},
    };

    return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import React from 'react';
import type { PendingBatchApproval } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import type { BatchApprovalDecision } from '@beaver/agent-core/run-state/batchApprovalAnswers';
import { BatchApprovalCard } from '@beaver/agent-ui/chat/BatchApprovalCard';

const GOAL = 'Assign one broad topic tag to every item and remove all prior tags';
const WARNING = 'Removes every existing tag from these items';
const CREDIT_NOTE = 'Approving raises this thread’s confirmation limit to 12 credits.';

function approval(overrides: Partial<PendingBatchApproval> = {}): PendingBatchApproval {
    return {
        approvalId: 'approval-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolcallId: 'call-1',
        batchId: 'b1',
        title: 'Approve batch operation',
        message: GOAL,
        destructiveWarning: WARNING,
        creditNote: CREDIT_NOTE,
        defaultMode: 'full_access',
        approveLabel: 'Approve',
        declineLabel: 'Reject',
        timeoutSeconds: 180,
        ...overrides,
    };
}

type Element = React.ReactElement<Record<string, any>>;

/** Every element in the tree matching the predicate, in render order. */
function findAll(node: React.ReactNode, match: (el: Element) => boolean, out: Element[] = []): Element[] {
    if (Array.isArray(node)) {
        node.forEach((child) => findAll(child, match, out));
        return out;
    }
    if (!React.isValidElement(node)) return out;
    const el = node as Element;
    if (match(el)) out.push(el);
    findAll(el.props.children ?? null, match, out);
    return out;
}

function findOne(node: React.ReactNode, match: (el: Element) => boolean): Element {
    const found = findAll(node, match);
    expect(found.length).toBeGreaterThan(0);
    return found[0];
}

/** Every string the card renders, joined — what the user actually reads. */
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
    renderedText((node as Element).props.children ?? null, out);
    return out;
}

const byAriaLabel = (label: string) => (el: Element) => el.props.ariaLabel === label;
const isWarningBlock = (el: Element) => el.props.role === 'note';
const isTextarea = (el: Element) => el.type === 'textarea';
const isModeMenu = (el: Element) => Array.isArray(el.props.options) && !!el.props.onChange;

const ENTER = { key: 'Enter', stopPropagation: () => {} } as any;

/** One render of the card. Hook state persists across calls within a test. */
function render(
    onSubmit: (response: BatchApprovalDecision) => void,
    overrides: Partial<PendingBatchApproval> = {},
    onStop: () => void = () => {},
) {
    hookState.index = 0;
    return BatchApprovalCard({
        approval: approval(overrides),
        onSubmit,
        onStop,
    }) as React.ReactNode;
}

describe('BatchApprovalCard one-decision guard', () => {
    beforeEach(() => {
        hookState.slots = [];
        hookState.index = 0;
    });

    it('sends the approval once when Approve is clicked', () => {
        const onSubmit = vi.fn();

        findOne(render(onSubmit), byAriaLabel('Approve batch operation')).props.onClick();

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({
            approved: true,
            mode: 'full_access',
            user_instructions: null,
        });
    });

    it('sends one decision when Approve is clicked twice before the re-render', () => {
        const onSubmit = vi.fn();
        const approve = findOne(render(onSubmit), byAriaLabel('Approve batch operation')).props.onClick;

        approve();
        approve();

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('sends one decision when Approve and Reject land in the same tick', () => {
        const onSubmit = vi.fn();
        const tree = render(onSubmit);

        findOne(tree, byAriaLabel('Approve batch operation')).props.onClick();
        findOne(tree, byAriaLabel('Reject batch operation')).props.onClick();

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({
            approved: true,
            mode: 'full_access',
            user_instructions: null,
        });
    });

    it('sends one decision when a click and a stray Enter land in the same tick', () => {
        const onSubmit = vi.fn();
        const tree = render(onSubmit);

        findOne(tree, byAriaLabel('Approve batch operation')).props.onClick();
        findOne(tree, isTextarea).props.onKeyDown(ENTER);

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });
});

describe('BatchApprovalCard decision payload', () => {
    beforeEach(() => {
        hookState.slots = [];
        hookState.index = 0;
    });

    /** Types instructions, picks a mode, and re-renders with both in place. */
    function prepared(onSubmit: (response: BatchApprovalDecision) => void) {
        const tree = render(onSubmit);
        findOne(tree, isTextarea).props.onChange({ target: { value: '  keep p53 and p63  ' } });
        findOne(tree, isModeMenu).props.onChange('ask_each_time');
        return render(onSubmit);
    }

    it('carries the mode and the trimmed instructions on Approve', () => {
        const onSubmit = vi.fn();

        findOne(prepared(onSubmit), byAriaLabel('Approve batch operation')).props.onClick();

        expect(onSubmit).toHaveBeenCalledWith({
            approved: true,
            mode: 'ask_each_time',
            user_instructions: 'keep p53 and p63',
        });
    });

    it('carries the mode and the trimmed instructions on Reject', () => {
        const onSubmit = vi.fn();

        findOne(prepared(onSubmit), byAriaLabel('Reject batch operation')).props.onClick();

        expect(onSubmit).toHaveBeenCalledWith({
            approved: false,
            mode: 'ask_each_time',
            user_instructions: 'keep p53 and p63',
        });
    });

    it('starts on the mode the request preselects', () => {
        const onSubmit = vi.fn();

        findOne(
            render(onSubmit, { defaultMode: 'ask_each_time' }),
            byAriaLabel('Approve batch operation'),
        ).props.onClick();

        expect(onSubmit).toHaveBeenCalledWith({
            approved: true,
            mode: 'ask_each_time',
            user_instructions: null,
        });
    });

    it('does not decide when Enter is pressed in the instructions field', () => {
        const onSubmit = vi.fn();

        findOne(render(onSubmit), isTextarea).props.onKeyDown(ENTER);

        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('stops the run without deciding the batch', () => {
        // Stop cancels the run; it is not a decline, so nothing goes on the wire.
        const onSubmit = vi.fn();
        const onStop = vi.fn();

        findOne(render(onSubmit, {}, onStop), byAriaLabel('Stop generating')).props.onClick();

        expect(onStop).toHaveBeenCalledTimes(1);
        expect(onSubmit).not.toHaveBeenCalled();
    });
});

describe('BatchApprovalCard backend copy', () => {
    beforeEach(() => {
        hookState.slots = [];
        hookState.index = 0;
    });

    it('renders the goal, the warning block and the credit note verbatim', () => {
        const text = renderedText(render(vi.fn()));

        expect(text).toContain(GOAL);
        expect(text).toContain(WARNING);
        expect(text).toContain(CREDIT_NOTE);
        expect(findAll(render(vi.fn()), isWarningBlock)).toHaveLength(1);
    });

    it('hides the warning block when the batch declared nothing destructive', () => {
        const tree = render(vi.fn(), { destructiveWarning: '' });

        expect(findAll(tree, isWarningBlock)).toHaveLength(0);
        expect(renderedText(tree)).toContain(GOAL);
    });

    it('hides the credit note when the run has none', () => {
        const tree = render(vi.fn(), { creditNote: '' });

        expect(renderedText(tree)).not.toContain(CREDIT_NOTE);
        expect(renderedText(tree)).toContain(GOAL);
    });
});
