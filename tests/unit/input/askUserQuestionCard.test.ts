/**
 * The ask_user_question card's one-response guard.
 *
 * Exactly one response may leave the client: the run correlates on the
 * question id and a second one arrives after the backend has stopped
 * listening. The card is still mounted and still enabled in the instant after
 * the answers go out, and two of its controls submit — the Submit button and
 * Enter in the custom-answer field — so both can fire before React re-renders
 * with the controls disabled.
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
        // The card's only effect fits the custom-answer field's height to its
        // content, which needs a laid-out DOM node this harness never creates.
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

/** One render of the card. Hook state persists across calls within a test. */
function render(onSubmit: (answers: AskUserQuestionAnswer[]) => void, questions?: AskUserQuestionItem[]) {
    hookState.index = 0;
    return AskUserQuestionCard({
        pendingQuestion: pendingQuestion(questions),
        onSubmit,
        onStop: () => {},
    }) as React.ReactNode;
}

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
        // keypress still in flight from the custom-answer field.
        const onSubmit = vi.fn();
        const tree = answered(onSubmit);

        findOne(tree, byAriaLabel('Submit answers')).props.onClick();
        findOne(tree, isTextarea).props.onKeyDown(ENTER);

        expect(onSubmit).toHaveBeenCalledTimes(1);
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
