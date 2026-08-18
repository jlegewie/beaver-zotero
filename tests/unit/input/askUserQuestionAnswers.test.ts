/**
 * The answer rules behind the ask_user_question card.
 *
 * These pin the semantics a client's card must not drift from: radio vs.
 * checkbox selection, when a free-text 'Other' answer counts as an answer, and
 * exactly what leaves the client on the wire. The rules live in a host-free
 * module precisely so they can be exercised here as plain functions, with no
 * DOM and no component in the way.
 */
import { describe, expect, it } from 'vitest';

import type { AskUserQuestionItem } from '@beaver/agent-core/protocol/agentProtocol';
import type { QuestionDraft } from '@beaver/agent-core/run-state/askUserQuestionAnswers';
import {
    EMPTY_QUESTION_DRAFT,
    allowsCustomAnswer,
    buildAnswers,
    clearAnswer,
    isQuestionAnswered,
    selectOther,
    setCustomText,
    toggleOption,
    toggleOther,
} from '@beaver/agent-core/run-state/askUserQuestionAnswers';

function question(overrides: Partial<AskUserQuestionItem> = {}): AskUserQuestionItem {
    return {
        id: 'q0',
        question: 'Which sources should I use?',
        options: [
            { id: 'q0-o1', label: 'Everything in my library' },
            { id: 'q0-o2', label: 'Only the selected collection' },
            { id: 'q0-o3', label: 'Only the open item' },
        ],
        ...overrides,
    };
}

const single = question();
const multi = question({ allow_multiple: true });
const noCustom = question({ allow_custom: false });

describe('allowsCustomAnswer', () => {
    it('offers the free-text answer unless the backend opted out', () => {
        expect(allowsCustomAnswer(single)).toBe(true);
        expect(allowsCustomAnswer(question({ allow_custom: true }))).toBe(true);
        expect(allowsCustomAnswer(noCustom)).toBe(false);
    });
});

describe('toggleOption', () => {
    it('replaces the selection on a single-select question', () => {
        const first = toggleOption(single, 'q0-o1', EMPTY_QUESTION_DRAFT);
        const second = toggleOption(single, 'q0-o2', first);

        expect(first.selections.q0).toEqual(['q0-o1']);
        expect(second.selections.q0).toEqual(['q0-o2']);
    });

    it('deselects the selected option when it is clicked again', () => {
        const selected = toggleOption(single, 'q0-o1', EMPTY_QUESTION_DRAFT);

        expect(toggleOption(single, 'q0-o1', selected).selections.q0).toEqual([]);
    });

    it('accumulates and removes on a multi-select question', () => {
        const one = toggleOption(multi, 'q0-o1', EMPTY_QUESTION_DRAFT);
        const two = toggleOption(multi, 'q0-o2', one);
        const three = toggleOption(multi, 'q0-o3', two);

        expect(three.selections.q0).toEqual(['q0-o1', 'q0-o2', 'q0-o3']);
        expect(toggleOption(multi, 'q0-o2', three).selections.q0).toEqual(['q0-o1', 'q0-o3']);
    });

    it('deselects Other on a single-select question — radio semantics', () => {
        const withOther = setCustomText(single, 'a third way', EMPTY_QUESTION_DRAFT);
        expect(withOther.otherSelected.q0).toBe(true);

        const picked = toggleOption(single, 'q0-o1', withOther);

        expect(picked.otherSelected.q0).toBe(false);
        expect(picked.selections.q0).toEqual(['q0-o1']);
    });

    it('leaves Other selected on a multi-select question', () => {
        const withOther = setCustomText(multi, 'a third way', EMPTY_QUESTION_DRAFT);

        const picked = toggleOption(multi, 'q0-o1', withOther);

        expect(picked.otherSelected.q0).toBe(true);
        expect(picked.selections.q0).toEqual(['q0-o1']);
    });
});

describe('selectOther / toggleOther', () => {
    it('clears the listed selections on a single-select question', () => {
        const picked = toggleOption(single, 'q0-o1', EMPTY_QUESTION_DRAFT);

        const other = selectOther(single, picked);

        expect(other.otherSelected.q0).toBe(true);
        expect(other.selections.q0).toEqual([]);
    });

    it('keeps the listed selections on a multi-select question', () => {
        const picked = toggleOption(multi, 'q0-o1', EMPTY_QUESTION_DRAFT);

        const other = selectOther(multi, picked);

        expect(other.otherSelected.q0).toBe(true);
        expect(other.selections.q0).toEqual(['q0-o1']);
    });

    it('toggleOther deselects an already selected Other and nothing else', () => {
        const typed = setCustomText(single, 'a third way', EMPTY_QUESTION_DRAFT);

        const off = toggleOther(single, typed);

        expect(off.otherSelected.q0).toBe(false);
        // The text survives so a re-select restores what the user typed; it
        // just stops counting while Other is off.
        expect(off.customTexts.q0).toBe('a third way');
    });

    it('toggleOther selects Other when it is off', () => {
        expect(toggleOther(single, EMPTY_QUESTION_DRAFT).otherSelected.q0).toBe(true);
    });
});

describe('setCustomText', () => {
    it('selects Other and stores the text untrimmed', () => {
        const typed = setCustomText(single, '  a third way  ', EMPTY_QUESTION_DRAFT);

        expect(typed.otherSelected.q0).toBe(true);
        expect(typed.customTexts.q0).toBe('  a third way  ');
    });
});

describe('isQuestionAnswered', () => {
    it('is false for an untouched draft', () => {
        expect(isQuestionAnswered(single, EMPTY_QUESTION_DRAFT)).toBe(false);
    });

    it('is true once an option is selected', () => {
        expect(isQuestionAnswered(single, toggleOption(single, 'q0-o1', EMPTY_QUESTION_DRAFT))).toBe(true);
    });

    it('is false for Other selected with nothing typed', () => {
        expect(isQuestionAnswered(single, selectOther(single, EMPTY_QUESTION_DRAFT))).toBe(false);
    });

    it('is false for Other selected with whitespace only', () => {
        expect(isQuestionAnswered(single, setCustomText(single, '   ', EMPTY_QUESTION_DRAFT))).toBe(false);
    });

    it('is true once real text is typed', () => {
        expect(isQuestionAnswered(single, setCustomText(single, 'a third way', EMPTY_QUESTION_DRAFT))).toBe(true);
    });

    it('is false when the text was typed and Other was then deselected', () => {
        const typed = setCustomText(single, 'a third way', EMPTY_QUESTION_DRAFT);

        expect(isQuestionAnswered(single, toggleOther(single, typed))).toBe(false);
    });

    it('is false when the question offers no custom answer, text or not', () => {
        const typed = setCustomText(noCustom, 'a third way', EMPTY_QUESTION_DRAFT);

        expect(typed.otherSelected.q0).toBe(true);
        expect(isQuestionAnswered(noCustom, typed)).toBe(false);
    });
});

describe('buildAnswers', () => {
    const q0 = question({ id: 'q0' });
    const q1 = question({ id: 'q1', options: [{ id: 'q1-o1', label: 'Yes' }] });

    it('emits one entry per question, in order, including unanswered ones', () => {
        const draft = toggleOption(q1, 'q1-o1', EMPTY_QUESTION_DRAFT);

        expect(buildAnswers([q0, q1], draft)).toEqual([
            { item_id: 'q0', selected_option_ids: [], custom_text: null },
            { item_id: 'q1', selected_option_ids: ['q1-o1'], custom_text: null },
        ]);
    });

    it('trims the custom text', () => {
        const draft = setCustomText(q0, '  a third way  ', EMPTY_QUESTION_DRAFT);

        expect(buildAnswers([q0], draft)[0].custom_text).toBe('a third way');
    });

    it('sends null for a whitespace-only custom text', () => {
        const draft = setCustomText(q0, '   ', EMPTY_QUESTION_DRAFT);

        expect(buildAnswers([q0], draft)[0].custom_text).toBeNull();
    });

    it('sends null for text left behind after Other was deselected', () => {
        const draft = toggleOther(q0, setCustomText(q0, 'a third way', EMPTY_QUESTION_DRAFT));

        expect(buildAnswers([q0], draft)[0].custom_text).toBeNull();
    });

    it('never sends custom text for a question that offers none', () => {
        const draft = setCustomText(noCustom, 'a third way', EMPTY_QUESTION_DRAFT);

        expect(buildAnswers([noCustom], draft)[0].custom_text).toBeNull();
    });

    it('sends an empty answer for a cleared question', () => {
        const answered = setCustomText(q0, 'a third way', toggleOption(q0, 'q0-o1', EMPTY_QUESTION_DRAFT));

        const [answer] = buildAnswers([q0], clearAnswer(q0, answered));

        expect(answer).toEqual({ item_id: 'q0', selected_option_ids: [], custom_text: null });
    });
});

describe('draft identity', () => {
    // A caller holds the draft in component state, so a transition that changes
    // nothing must not hand back a new object and force a re-render.
    it('selectOther is idempotent', () => {
        const other = selectOther(single, EMPTY_QUESTION_DRAFT);

        expect(selectOther(single, other)).toBe(other);
    });

    it('setCustomText returns the same draft for unchanged text', () => {
        const typed = setCustomText(single, 'a third way', EMPTY_QUESTION_DRAFT);

        expect(setCustomText(single, 'a third way', typed)).toBe(typed);
    });

    it('clearAnswer returns the same draft when there is nothing to clear', () => {
        const draft: QuestionDraft = EMPTY_QUESTION_DRAFT;

        expect(clearAnswer(single, draft)).toBe(draft);
    });

    it('leaves the source draft untouched', () => {
        const before = EMPTY_QUESTION_DRAFT;

        toggleOption(single, 'q0-o1', before);
        setCustomText(single, 'a third way', before);

        expect(before.selections).toEqual({});
        expect(before.customTexts).toEqual({});
        expect(before.otherSelected).toEqual({});
    });
});
