/**
 * The user's in-progress answers to one ask_user_question request, and the
 * rules that turn them into wire answers.
 *
 * Host-free on purpose: every client that renders the question card shares
 * these semantics, so they live here rather than in one client's component.
 * All transitions are pure and return a NEW draft — never mutate one. They
 * return the SAME draft object when nothing changes, which is what keeps a
 * React caller holding the draft in state from re-rendering for nothing.
 */

import type {
    AskUserQuestionAnswer,
    AskUserQuestionItem,
} from '../protocol/agentProtocol';

/** The user's in-progress answers to one ask_user_question request. */
export interface QuestionDraft {
    /** Selected option ids, per question id. */
    selections: Record<string, string[]>;
    /** The free-text 'Other' answer, per question id. */
    customTexts: Record<string, string>;
    /** Whether 'Other' is selected, per question id. */
    otherSelected: Record<string, boolean>;
}

/** A draft with nothing answered yet. */
export const EMPTY_QUESTION_DRAFT: QuestionDraft = {
    selections: {},
    customTexts: {},
    otherSelected: {},
};

/** Whether the question offers a free-text 'Other' answer. Absent means yes. */
export function allowsCustomAnswer(question: AskUserQuestionItem): boolean {
    return question.allow_custom ?? true;
}

/**
 * Whether the question carries an answer that may be submitted.
 *
 * Custom text counts only while 'Other' is selected: an 'Other' selection with
 * nothing typed is not an answer, and text left behind after deselecting
 * 'Other' neither counts nor gets sent.
 */
export function isQuestionAnswered(question: AskUserQuestionItem, draft: QuestionDraft): boolean {
    return (
        (draft.selections[question.id]?.length ?? 0) > 0 ||
        (allowsCustomAnswer(question) &&
            !!draft.otherSelected[question.id] &&
            (draft.customTexts[question.id]?.trim() ?? '') !== '')
    );
}

/** Apply a click on one of the question's listed options. */
export function toggleOption(
    question: AskUserQuestionItem,
    optionId: string,
    draft: QuestionDraft,
): QuestionDraft {
    const current = draft.selections[question.id] ?? [];
    const isSelected = current.includes(optionId);
    const next = question.allow_multiple
        ? (isSelected ? current.filter((id) => id !== optionId) : [...current, optionId])
        // Single-select: clicking the selected option deselects it.
        : (isSelected ? [] : [optionId]);
    // Radio semantics: on a single-select question, picking a listed option
    // deselects 'Other'. A multi-select question keeps 'Other' selected.
    const otherSelected = !question.allow_multiple && draft.otherSelected[question.id]
        ? { ...draft.otherSelected, [question.id]: false }
        : draft.otherSelected;
    return {
        ...draft,
        selections: { ...draft.selections, [question.id]: next },
        otherSelected,
    };
}

/**
 * Select 'Other'. Idempotent — for the path where focusing the text field
 * selects it. Radio semantics: clears the listed selections when the question
 * is single-select.
 */
export function selectOther(question: AskUserQuestionItem, draft: QuestionDraft): QuestionDraft {
    const otherSelected = draft.otherSelected[question.id]
        ? draft.otherSelected
        : { ...draft.otherSelected, [question.id]: true };
    const selections = !question.allow_multiple && (draft.selections[question.id]?.length ?? 0) > 0
        ? { ...draft.selections, [question.id]: [] }
        : draft.selections;
    if (otherSelected === draft.otherSelected && selections === draft.selections) return draft;
    return { ...draft, otherSelected, selections };
}

/** Select or deselect 'Other'. */
export function toggleOther(question: AskUserQuestionItem, draft: QuestionDraft): QuestionDraft {
    if (draft.otherSelected[question.id]) {
        return {
            ...draft,
            otherSelected: { ...draft.otherSelected, [question.id]: false },
        };
    }
    return selectOther(question, draft);
}

/**
 * Record what the user typed as their 'Other' answer. Stored verbatim —
 * trimming happens at read time — and typing selects 'Other', so the text
 * counts towards the answer.
 */
export function setCustomText(
    question: AskUserQuestionItem,
    text: string,
    draft: QuestionDraft,
): QuestionDraft {
    const selected = selectOther(question, draft);
    if (selected.customTexts[question.id] === text) return selected;
    return {
        ...selected,
        customTexts: { ...selected.customTexts, [question.id]: text },
    };
}

/** Drop the question's answer entirely. */
export function clearAnswer(question: AskUserQuestionItem, draft: QuestionDraft): QuestionDraft {
    const alreadyClear =
        (draft.selections[question.id]?.length ?? 0) === 0 &&
        (draft.customTexts[question.id] ?? '') === '' &&
        !draft.otherSelected[question.id];
    if (alreadyClear) return draft;
    return {
        selections: { ...draft.selections, [question.id]: [] },
        customTexts: { ...draft.customTexts, [question.id]: '' },
        otherSelected: { ...draft.otherSelected, [question.id]: false },
    };
}

/**
 * The wire answers for every question of the request — including the ones the
 * user never answered, which travel with empty selections. A response where
 * every answer is empty is what the backend reads as a skip.
 */
export function buildAnswers(
    questions: AskUserQuestionItem[],
    draft: QuestionDraft,
): AskUserQuestionAnswer[] {
    return questions.map((question) => ({
        item_id: question.id,
        selected_option_ids: draft.selections[question.id] ?? [],
        custom_text:
            allowsCustomAnswer(question) && draft.otherSelected[question.id]
                ? (draft.customTexts[question.id]?.trim() || null)
                : null,
    }));
}
