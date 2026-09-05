/**
 * The ask_user_question card's one-response guard, Other field, and note field.
 *
 * Exactly one response may leave the client: the run correlates on the
 * question id and a second one arrives after the backend has stopped
 * listening. The card is still mounted and still enabled in the instant after
 * the answers go out, and two of its controls submit — the Submit button and
 * Enter in the Other or note field — so both can fire before React re-renders
 * with the controls disabled. The countdown's expiry goes through the same
 * guard.
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
        // The card's effects fit the note field's height to its content (needs
        // a laid-out DOM node this harness never creates) and arm the countdown
        // timers, which these tests drive by hand instead.
        useEffect: () => {},
    };

    return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import React from 'react';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@beaver/agent-core/protocol/agentProtocol';
import type { PendingQuestion } from '@beaver/agent-core/run-state/pendingQuestions';
import { AskUserQuestionCard } from '@beaver/agent-ui/chat/AskUserQuestionCard';

const QUESTION: AskUserQuestionItem = {
    id: 'q0',
    header: 'Scope',
    question: 'Which years should the review cover?',
    options: [
        { id: 'q0-o0', label: 'The last five years' },
        { id: 'q0-o1', label: 'Everything on record' },
    ],
    allow_multiple: false,
    allow_custom: true,
};

function pendingQuestion(questions: AskUserQuestionItem[] = [QUESTION]): PendingQuestion {
    return {
        questionId: 'question-1',
        toolcallId: 'toolcall-1',
        title: 'A question',
        questions,
        expiresAt: Date.now() + 600_000,
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

const byAriaLabel = (label: string) => (el: Element) => el.props.ariaLabel === label;
/** The listed options — the only buttons the card renders full-width. */
const isOptionButton = (el: Element) => el.props.className === 'text-left w-full';
const isTextarea = (el: Element) => el.type === 'textarea';
const ariaLabelOf = (el: Element): string | undefined =>
    el.props.ariaLabel ?? el.props['aria-label'];
const isOtherTextarea = (el: Element) =>
    el.type === 'textarea' && typeof ariaLabelOf(el) === 'string' && ariaLabelOf(el)!.startsWith('Custom answer for:');
const isNoteTextarea = (el: Element) =>
    el.type === 'textarea' && typeof ariaLabelOf(el) === 'string' && ariaLabelOf(el)!.startsWith('Note for:');

/**
 * One render of the card. Hook state persists across calls within a test.
 * `onExpire: null` renders a host without a clock (the prop left out).
 */
function render(
    onSubmit: (answers: AskUserQuestionAnswer[]) => void,
    questions?: AskUserQuestionItem[],
    onExpire: ((answers: AskUserQuestionAnswer[]) => void) | null = () => {},
) {
    hookState.index = 0;
    return AskUserQuestionCard({
        pendingQuestion: pendingQuestion(questions),
        onSubmit,
        onExpire: onExpire ?? undefined,
        onStop: () => {},
    }) as React.ReactNode;
}

const isTimer = (el: Element) => el.props.role === 'timer';
/** The countdown hook's expiry callback, as the deadline timer would call it. */
const fireDeadline = () =>
    hookState.slots.find((s) => s.value && typeof s.value.current === 'function')!.value.current();

/** Opens the note field and re-renders with it in place. */
function withNoteOpen(onSubmit: (answers: AskUserQuestionAnswer[]) => void) {
    findOne(render(onSubmit), byAriaLabel('Add a note')).props.onClick();
    return render(onSubmit);
}

const typeOther = (tree: React.ReactNode, text: string) =>
    findOne(tree, isOtherTextarea).props.onChange({ target: { value: text } });

const typeNote = (tree: React.ReactNode, text: string) =>
    findOne(tree, isNoteTextarea).props.onChange({ target: { value: text } });

const ENTER = { key: 'Enter', shiftKey: false, preventDefault: () => {} } as any;

describe('AskUserQuestionCard double-submit guard', () => {
    beforeEach(() => {
        hookState.slots = [];
        hookState.index = 0;
    });

    /** Renders, answers the question, and re-renders with the answer in place. */
    function answered(onSubmit: (answers: AskUserQuestionAnswer[]) => void) {
        findOne(render(onSubmit), isOptionButton).props.onClick();
        return render(onSubmit);
    }

    it('sends the answers once when Submit is clicked', () => {
        const onSubmit = vi.fn();

        findOne(answered(onSubmit), byAriaLabel('Submit answers')).props.onClick();

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith([
            { item_id: 'q0', selected_option_ids: ['q0-o0'], custom_text: null },
        ]);
    });

    it('sends one response when Submit is clicked twice before the re-render', () => {
        const onSubmit = vi.fn();
        const submit = findOne(answered(onSubmit), byAriaLabel('Submit answers')).props.onClick;

        submit();
        submit();

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('sends one response when Submit and Enter land in the same tick', () => {
        // The two paths that can fire together: the mouse on Submit and a
        // keypress still in flight from the Other field (always on the card).
        const onSubmit = vi.fn();
        const tree = answered(onSubmit);

        findOne(tree, byAriaLabel('Submit answers')).props.onClick();
        findOne(tree, isOtherTextarea).props.onKeyDown(ENTER);

        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('sends nothing on expiry once the answers have gone out', () => {
        const onSubmit = vi.fn();
        const onExpire = vi.fn();
        findOne(render(onSubmit, undefined, onExpire), isOptionButton).props.onClick();
        const tree = render(onSubmit, undefined, onExpire);

        findOne(tree, byAriaLabel('Submit answers')).props.onClick();
        // The deadline timer fires in the same tick as the click.
        fireDeadline();

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onExpire).not.toHaveBeenCalled();
    });

    it('sends one response when Skip follows a submit in the same tick', () => {
        // Skip on the last question submits too, with the question cleared.
        const onSubmit = vi.fn();
        const tree = answered(onSubmit);

        findOne(tree, byAriaLabel('Submit answers')).props.onClick();
        findOne(tree, byAriaLabel('Skip this question and submit')).props.onClick();

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith([
            { item_id: 'q0', selected_option_ids: ['q0-o0'], custom_text: null },
        ]);
    });
});


describe('AskUserQuestionCard note field', () => {
    beforeEach(() => {
        hookState.slots = [];
        hookState.index = 0;
    });

    it('is closed until asked for, then replaces the affordance', () => {
        const onSubmit = vi.fn();
        const closed = render(onSubmit);
        expect(findAll(closed, isNoteTextarea)).toHaveLength(0);
        expect(findAll(closed, isOtherTextarea)).toHaveLength(1);

        const open = withNoteOpen(onSubmit);
        expect(findAll(open, isNoteTextarea)).toHaveLength(1);
        expect(findAll(open, byAriaLabel('Add a note'))).toHaveLength(0);
    });

    it('is not offered when the question disallows a custom answer', () => {
        const tree = render(vi.fn(), [{ ...QUESTION, allow_custom: false }]);

        expect(findAll(tree, byAriaLabel('Add a note'))).toHaveLength(0);
        expect(findAll(tree, isTextarea)).toHaveLength(0);
        expect(findAll(tree, byAriaLabel('Other (custom answer)'))).toHaveLength(0);
    });

    it('a note alone is a submittable answer', () => {
        const onSubmit = vi.fn();
        typeNote(withNoteOpen(onSubmit), 'the last decade, but only reviews');
        const tree = render(onSubmit);

        const submit = findOne(tree, byAriaLabel('Submit answers'));
        expect(submit.props.disabled).toBe(false);
        submit.props.onClick();

        expect(onSubmit).toHaveBeenCalledWith([
            { item_id: 'q0', selected_option_ids: [], custom_text: 'the last decade, but only reviews' },
        ]);
    });

    it('a note rides along with the selected option', () => {
        const onSubmit = vi.fn();
        typeNote(withNoteOpen(onSubmit), 'skip anything before 2015');
        findOne(render(onSubmit), isOptionButton).props.onClick();
        const tree = render(onSubmit);

        findOne(tree, byAriaLabel('Submit answers')).props.onClick();

        expect(onSubmit).toHaveBeenCalledWith([
            { item_id: 'q0', selected_option_ids: ['q0-o0'], custom_text: 'skip anything before 2015' },
        ]);
    });

    it('an Other answer is sent as custom_text', () => {
        const onSubmit = vi.fn();
        typeOther(render(onSubmit), 'the last decade, but only reviews');
        const tree = render(onSubmit);

        findOne(tree, byAriaLabel('Submit answers')).props.onClick();

        expect(onSubmit).toHaveBeenCalledWith([
            { item_id: 'q0', selected_option_ids: [], custom_text: 'the last decade, but only reviews' },
        ]);
    });

    it('joins Other and the note onto one custom_text', () => {
        const onSubmit = vi.fn();
        typeOther(render(onSubmit), 'a third way');
        typeNote(withNoteOpen(onSubmit), 'skip anything before 2015');
        const tree = render(onSubmit);

        findOne(tree, byAriaLabel('Submit answers')).props.onClick();

        expect(onSubmit).toHaveBeenCalledWith([
            { item_id: 'q0', selected_option_ids: [], custom_text: 'a third way\n\nskip anything before 2015' },
        ]);
    });

    it('a blank note does not enable Submit', () => {
        const onSubmit = vi.fn();
        typeNote(withNoteOpen(onSubmit), '   ');

        expect(findOne(render(onSubmit), byAriaLabel('Submit answers')).props.disabled).toBe(true);
    });

    it('expiry sends the partial answers through onExpire, not onSubmit', () => {
        const onSubmit = vi.fn();
        const onExpire = vi.fn();
        findOne(render(onSubmit, undefined, onExpire), isOptionButton).props.onClick();
        render(onSubmit, undefined, onExpire);

        // The latest expiry callback the countdown hook holds in its ref.
        fireDeadline();

        expect(onExpire).toHaveBeenCalledTimes(1);
        expect(onExpire).toHaveBeenCalledWith([
            { item_id: 'q0', selected_option_ids: ['q0-o0'], custom_text: null },
        ]);
        expect(onSubmit).not.toHaveBeenCalled();
    });
});

describe('AskUserQuestionCard without a host clock', () => {
    // A host whose backend retires the question through the tool return (the
    // Word add-in) passes no onExpire. The card then runs no countdown, draws
    // none, and never latches its controls on its own.
    beforeEach(() => {
        hookState.slots = [];
        hookState.index = 0;
    });

    it('draws a countdown only when the host can receive an expiry', () => {
        expect(findAll(render(vi.fn()), isTimer)).toHaveLength(1);
        expect(findAll(render(vi.fn(), undefined, null), isTimer)).toHaveLength(0);
    });

    it('keeps the controls live when the deadline callback fires with no host handler', () => {
        const onSubmit = vi.fn();
        findOne(render(onSubmit, undefined, null), isOptionButton).props.onClick();
        render(onSubmit, undefined, null);

        fireDeadline();
        const tree = render(onSubmit, undefined, null);

        const submit = findOne(tree, byAriaLabel('Submit answers'));
        expect(submit.props.disabled).toBe(false);
        submit.props.onClick();
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });
});
