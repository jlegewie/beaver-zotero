/**
 * The user's in-progress answers to one ask_user_question request, and the
 * rules that turn them into wire answers.
 *
 * Host-free on purpose: every client that renders the question card shares
 * these semantics, so they live here rather than in one client's component.
 * All transitions are pure and return a NEW draft — never mutate one. They
 * return the SAME draft object when nothing changes, which is what keeps a
 * React caller holding the draft in state from re-rendering for nothing.
 *
 * A question is answered by a listed selection, by an Other answer, by a
 * free-text note, or by any combination. Other is a custom option: its text
 * counts only while Other is selected. The note is independent of the
 * selection — on its own it is the user's own answer, alongside a selection
 * or Other it qualifies the choice. The wire has one `custom_text`, so Other
 * and the note are joined when both are present.
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
    /** The free-text note, per question id. Independent of Other and the selection. */
    notes: Record<string, string>;
}

/** A draft with nothing answered yet. */
export const EMPTY_QUESTION_DRAFT: QuestionDraft = {
    selections: {},
    customTexts: {},
    otherSelected: {},
    notes: {},
};

/** Whether the question offers a free-text 'Other' answer and a note. Absent means yes. */
export function allowsCustomAnswer(question: AskUserQuestionItem): boolean {
    return question.allow_custom ?? true;
}

/** The Other text, trimmed, only while Other is selected; empty otherwise. */
export function otherText(question: AskUserQuestionItem, draft: QuestionDraft): string {
    if (!allowsCustomAnswer(question) || !draft.otherSelected[question.id]) return '';
    return draft.customTexts[question.id]?.trim() ?? '';
}

/** The note the user typed, trimmed; empty when there is none. */
export function noteText(question: AskUserQuestionItem, draft: QuestionDraft): string {
    if (!allowsCustomAnswer(question)) return '';
    return draft.notes[question.id]?.trim() ?? '';
}

/**
 * The free text that leaves on the wire: Other, the note, or both joined.
 * Empty when neither is present (or the question offers none).
 */
export function customText(question: AskUserQuestionItem, draft: QuestionDraft): string {
    const other = otherText(question, draft);
    const note = noteText(question, draft);
    if (other && note) return `${other}\n\n${note}`;
    return other || note;
}

/**
 * Whether the question carries an answer that may be submitted: at least one
 * selected option, a non-blank Other answer while Other is selected, or a
 * non-blank note when the question offers one.
 *
 * An Other selection with nothing typed is not an answer, and Other text left
 * behind after deselecting Other neither counts nor gets sent.
 */
export function isQuestionAnswered(question: AskUserQuestionItem, draft: QuestionDraft): boolean {
    return (
        (draft.selections[question.id]?.length ?? 0) > 0 ||
        otherText(question, draft) !== '' ||
        noteText(question, draft) !== ''
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
 * is single-select. Leaves the note alone.
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
 * counts towards the answer. Leaves the note alone.
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

/**
 * Record what the user typed as their note. Stored verbatim — trimming
 * happens at read time. Leaves the selection and Other alone.
 */
export function setNote(
    question: AskUserQuestionItem,
    text: string,
    draft: QuestionDraft,
): QuestionDraft {
    if ((draft.notes[question.id] ?? '') === text) return draft;
    return {
        ...draft,
        notes: { ...draft.notes, [question.id]: text },
    };
}

/** Drop the question's answer entirely. */
export function clearAnswer(question: AskUserQuestionItem, draft: QuestionDraft): QuestionDraft {
    const alreadyClear =
        (draft.selections[question.id]?.length ?? 0) === 0 &&
        (draft.customTexts[question.id] ?? '') === '' &&
        !draft.otherSelected[question.id] &&
        (draft.notes[question.id] ?? '') === '';
    if (alreadyClear) return draft;
    return {
        selections: { ...draft.selections, [question.id]: [] },
        customTexts: { ...draft.customTexts, [question.id]: '' },
        otherSelected: { ...draft.otherSelected, [question.id]: false },
        notes: { ...draft.notes, [question.id]: '' },
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
        custom_text: customText(question, draft) || null,
    }));
}

/** Whether any wire answer carries a selection or free text. */
export function hasAnyAnswer(answers: AskUserQuestionAnswer[]): boolean {
    return answers.some(
        (answer) => answer.selected_option_ids.length > 0 || !!answer.custom_text?.trim(),
    );
}
