/**
 * The answer rules behind the ask_user_question card.
 *
 * These pin the semantics a client's card must not drift from: radio vs.
 * checkbox selection, when a free-text Other answer counts, that the note is
 * independent of the selection and of Other, and exactly what leaves the
 * client on the wire — including Other and the note joined when both are
 * present. The rules live in a host-free module precisely so they can be
 * exercised here as plain functions, with no DOM and no component in the way.
 */
import { describe, expect, it } from 'vitest';

import type { AskUserQuestionItem } from '@beaver/agent-core/protocol/agentProtocol';
import type { QuestionDraft } from '@beaver/agent-core/run-state/askUserQuestionAnswers';
import {
    EMPTY_QUESTION_DRAFT,
    hasAnyAnswer,
    allowsCustomAnswer,
    buildAnswers,
    clearAnswer,
    customText,
    isQuestionAnswered,
    noteText,
    otherText,
    selectOther,
    setCustomText,
    setNote,
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
    it('offers Other and the note unless the backend opted out', () => {
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

    it('leaves the note alone — selection and note are independent', () => {
        const noted = setNote(single, 'but only from 2020 on', EMPTY_QUESTION_DRAFT);

        const picked = toggleOption(single, 'q0-o1', noted);

        expect(picked.selections.q0).toEqual(['q0-o1']);
        expect(picked.notes.q0).toBe('but only from 2020 on');
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

    it('clears a listed selection on a single-select question', () => {
        const picked = toggleOption(single, 'q0-o2', EMPTY_QUESTION_DRAFT);

        const typed = setCustomText(single, 'a third way', picked);

        expect(typed.selections.q0).toEqual([]);
        expect(typed.otherSelected.q0).toBe(true);
    });
});

describe('setNote', () => {
    it('stores the text untrimmed and leaves the selection and Other alone', () => {
        const picked = toggleOption(single, 'q0-o2', EMPTY_QUESTION_DRAFT);

        const typed = setNote(single, '  from 2020 on  ', picked);

        expect(typed.notes.q0).toBe('  from 2020 on  ');
        expect(typed.selections.q0).toEqual(['q0-o2']);
        expect(typed.otherSelected.q0).toBeUndefined();
    });

    it('reads back trimmed, and empty for a question that offers no note', () => {
        expect(noteText(single, setNote(single, '  from 2020 on  ', EMPTY_QUESTION_DRAFT))).toBe('from 2020 on');
        expect(noteText(noCustom, setNote(noCustom, 'from 2020 on', EMPTY_QUESTION_DRAFT))).toBe('');
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

    it('is true once real Other text is typed', () => {
        expect(isQuestionAnswered(single, setCustomText(single, 'a third way', EMPTY_QUESTION_DRAFT))).toBe(true);
    });

    it('is false when the Other text was typed and Other was then deselected', () => {
        const typed = setCustomText(single, 'a third way', EMPTY_QUESTION_DRAFT);

        expect(isQuestionAnswered(single, toggleOther(single, typed))).toBe(false);
    });

    it('is true for a note alone — the note is the user\'s own answer', () => {
        expect(isQuestionAnswered(single, setNote(single, 'a third way', EMPTY_QUESTION_DRAFT))).toBe(true);
    });

    it('is false for a whitespace-only note', () => {
        expect(isQuestionAnswered(single, setNote(single, '   ', EMPTY_QUESTION_DRAFT))).toBe(false);
    });

    it('is true for a selection with a note', () => {
        const both = setNote(single, 'from 2020 on', toggleOption(single, 'q0-o1', EMPTY_QUESTION_DRAFT));

        expect(isQuestionAnswered(single, both)).toBe(true);
    });

    it('ignores Other and the note when the question offers none', () => {
        const typed = setCustomText(noCustom, 'a third way', setNote(noCustom, 'from 2020 on', EMPTY_QUESTION_DRAFT));

        expect(typed.otherSelected.q0).toBe(true);
        expect(isQuestionAnswered(noCustom, typed)).toBe(false);
        expect(isQuestionAnswered(noCustom, toggleOption(noCustom, 'q0-o1', typed))).toBe(true);
    });
});

describe('customText', () => {
    it('is the Other text while Other is selected', () => {
        expect(customText(single, setCustomText(single, '  a third way  ', EMPTY_QUESTION_DRAFT))).toBe('a third way');
        expect(otherText(single, setCustomText(single, '  a third way  ', EMPTY_QUESTION_DRAFT))).toBe('a third way');
    });

    it('is the note when there is no Other answer', () => {
        expect(customText(single, setNote(single, '  from 2020 on  ', EMPTY_QUESTION_DRAFT))).toBe('from 2020 on');
    });

    it('joins Other and the note when both are present', () => {
        const both = setNote(
            single,
            'skip anything before 2015',
            setCustomText(single, 'a third way', EMPTY_QUESTION_DRAFT),
        );

        expect(customText(single, both)).toBe('a third way\n\nskip anything before 2015');
    });

    it('drops Other text after Other is deselected, but keeps the note', () => {
        const both = setNote(
            single,
            'from 2020 on',
            setCustomText(single, 'a third way', EMPTY_QUESTION_DRAFT),
        );

        expect(customText(single, toggleOther(single, both))).toBe('from 2020 on');
    });

    it('is empty for a question that offers no custom answer', () => {
        const typed = setCustomText(noCustom, 'a third way', setNote(noCustom, 'from 2020 on', EMPTY_QUESTION_DRAFT));

        expect(customText(noCustom, typed)).toBe('');
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

    it('trims the Other text', () => {
        const draft = setCustomText(q0, '  a third way  ', EMPTY_QUESTION_DRAFT);

        expect(buildAnswers([q0], draft)[0].custom_text).toBe('a third way');
    });

    it('sends a selection and its note together', () => {
        const draft = setNote(q0, '  from 2020 on  ', toggleOption(q0, 'q0-o1', EMPTY_QUESTION_DRAFT));

        expect(buildAnswers([q0], draft)[0]).toEqual({
            item_id: 'q0',
            selected_option_ids: ['q0-o1'],
            custom_text: 'from 2020 on',
        });
    });

    it('sends a note alone as the answer', () => {
        const draft = setNote(q0, 'a third way', EMPTY_QUESTION_DRAFT);

        expect(buildAnswers([q0], draft)[0]).toEqual({
            item_id: 'q0',
            selected_option_ids: [],
            custom_text: 'a third way',
        });
    });

    it('joins Other and the note onto one custom_text', () => {
        const draft = setNote(q0, 'skip anything before 2015', setCustomText(q0, 'a third way', EMPTY_QUESTION_DRAFT));

        expect(buildAnswers([q0], draft)[0]).toEqual({
            item_id: 'q0',
            selected_option_ids: [],
            custom_text: 'a third way\n\nskip anything before 2015',
        });
    });

    it('sends null for a whitespace-only Other text', () => {
        const draft = setCustomText(q0, '   ', EMPTY_QUESTION_DRAFT);

        expect(buildAnswers([q0], draft)[0].custom_text).toBeNull();
    });

    it('sends null for Other text left behind after Other was deselected', () => {
        const draft = toggleOther(q0, setCustomText(q0, 'a third way', EMPTY_QUESTION_DRAFT));

        expect(buildAnswers([q0], draft)[0].custom_text).toBeNull();
    });

    it('never sends custom text for a question that offers none', () => {
        const draft = setCustomText(noCustom, 'a third way', setNote(noCustom, 'from 2020 on', EMPTY_QUESTION_DRAFT));

        expect(buildAnswers([noCustom], draft)[0].custom_text).toBeNull();
    });

    it('sends an empty answer for a cleared question', () => {
        const answered = setNote(q0, 'from 2020 on', setCustomText(q0, 'a third way', toggleOption(q0, 'q0-o1', EMPTY_QUESTION_DRAFT)));

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

    it('setNote returns the same draft for unchanged text', () => {
        const typed = setNote(single, 'from 2020 on', EMPTY_QUESTION_DRAFT);

        expect(setNote(single, 'from 2020 on', typed)).toBe(typed);
    });

    it('clearAnswer returns the same draft when there is nothing to clear', () => {
        const draft: QuestionDraft = EMPTY_QUESTION_DRAFT;

        expect(clearAnswer(single, draft)).toBe(draft);
    });

    it('leaves the source draft untouched', () => {
        const before = EMPTY_QUESTION_DRAFT;

        toggleOption(single, 'q0-o1', before);
        setCustomText(single, 'a third way', before);
        setNote(single, 'from 2020 on', before);

        expect(before.selections).toEqual({});
        expect(before.customTexts).toEqual({});
        expect(before.otherSelected).toEqual({});
        expect(before.notes).toEqual({});
    });
});

describe('hasAnyAnswer', () => {
    it('is false when every wire answer is empty', () => {
        expect(hasAnyAnswer([
            { item_id: 'q0', selected_option_ids: [], custom_text: null },
            { item_id: 'q1', selected_option_ids: [], custom_text: '   ' },
        ])).toBe(false);
        expect(hasAnyAnswer([])).toBe(false);
    });

    it('is true for a selection or free text on any question', () => {
        expect(hasAnyAnswer([
            { item_id: 'q0', selected_option_ids: [], custom_text: null },
            { item_id: 'q1', selected_option_ids: ['q1-o1'], custom_text: null },
        ])).toBe(true);
        expect(hasAnyAnswer([
            { item_id: 'q0', selected_option_ids: [], custom_text: 'my own answer' },
        ])).toBe(true);
    });
});
