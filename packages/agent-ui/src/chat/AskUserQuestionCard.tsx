import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PendingQuestion } from '@beaver/agent-core/run-state/pendingQuestions';
import type {
    AskUserQuestionAnswer,
    AskUserQuestionItem,
} from '@beaver/agent-core/protocol/agentProtocol';
import type { QuestionDraft } from '@beaver/agent-core/run-state/askUserQuestionAnswers';
import {
    allowsCustomAnswer,
    buildAnswers,
    clearAnswer,
    EMPTY_QUESTION_DRAFT,
    isQuestionAnswered,
    selectOther,
    setCustomText,
    toggleOption,
    toggleOther,
} from '@beaver/agent-core/run-state/askUserQuestionAnswers';
import Button from '../primitives/Button';
import IconButton from '../primitives/IconButton';
import Tooltip from '../primitives/Tooltip';
import {
    ArrowLeftIcon,
    ArrowRightIcon,
    CheckmarkCircleSolidIcon,
    CircleIcon,
    Icon,
    StopStrokeIcon,
} from '../icons';

export interface AskUserQuestionCardProps {
    /** The request the run is blocked on, as the backend asked it. */
    pendingQuestion: PendingQuestion;
    /** The user's answers for every question of the request. */
    onSubmit: (answers: AskUserQuestionAnswer[]) => void;
    /** Abandon the run rather than answer it. */
    onStop: () => void;
}

/**
 * The question card for a pending ask_user_question request.
 *
 * Takes the place of the client's composer while the run blocks on the user's
 * answer, so the question sits where the user is already looking and cannot be
 * scrolled away. The user's draft message is untouched — the card neither
 * reads nor writes it, so the composer restores the draft when the card goes
 * away.
 *
 * One question is shown at a time. With multiple questions the header carries
 * a `< x of y >` stepper (back/forward navigation preserves answers); the
 * footer offers Stop (cancel the whole run), Skip (advance without answering
 * the current question), and Next/Submit (validated per question: at least
 * one selection, or custom text when offered). All answers are sent in a
 * single response on Submit — questions skipped along the way go out with
 * empty selections, and a response where every answer is empty is treated as
 * a skip by the backend.
 */
export const AskUserQuestionCard: React.FC<AskUserQuestionCardProps> = ({
    pendingQuestion,
    onSubmit,
    onStop,
}) => {
    const questions = pendingQuestion.questions;
    const total = questions.length;

    const [index, setIndex] = useState(0);
    // Selected option ids / custom text / "Other" selection per question id —
    // preserved across back/forward navigation, sent together on Submit.
    const [draft, setDraft] = useState<QuestionDraft>(EMPTY_QUESTION_DRAFT);
    // Drives the disabled styling in the instant before the card unmounts.
    const [isSubmitted, setIsSubmitted] = useState(false);
    // The guard that actually holds. Exactly one response may leave the
    // client: the run correlates on the question id, and a second one would
    // arrive after the backend stopped listening. The card is still mounted
    // right after the answers go out — the pending entry clears and React
    // re-renders asynchronously — and two of its controls can fire in the same
    // tick, since Enter in the custom-answer field submits just as the Submit
    // button does. `isSubmitted` only settles on the next render, so it cannot
    // block the second of them; this ref is set synchronously and does.
    const hasSubmittedRef = useRef(false);

    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const question: AskUserQuestionItem | undefined = questions[Math.min(index, total - 1)];
    const isLast = index >= total - 1;

    // Keep the custom-answer field's height fitted to its (per-question)
    // content when the card appears or the question changes. Deliberately no
    // focus here — the field is only focused when the user picks "Other".
    useEffect(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = `${ta.scrollHeight}px`;
    }, [index]);

    const handleOptionClick = (q: AskUserQuestionItem, optionId: string) => {
        setDraft((prev) => toggleOption(q, optionId, prev));
        // Move the caret out of the "Other" field when a listed option is
        // picked — refocusing/typing there would re-select Other.
        const ta = textareaRef.current;
        if (ta && ta.ownerDocument.activeElement === ta) ta.blur();
    };

    const handleOtherClick = (q: AskUserQuestionItem) => {
        const wasSelected = !!draft.otherSelected[q.id];
        setDraft((prev) => toggleOther(q, prev));
        if (!wasSelected) textareaRef.current?.focus();
    };

    const submitAnswers = useCallback((answers: AskUserQuestionAnswer[]) => {
        if (hasSubmittedRef.current) return;
        hasSubmittedRef.current = true;
        setIsSubmitted(true);
        onSubmit(answers);
    }, [onSubmit]);

    const submitAll = useCallback(() => {
        submitAnswers(buildAnswers(questions, draft));
    }, [submitAnswers, questions, draft]);

    const handleNext = useCallback(() => {
        if (!question || !isQuestionAnswered(question, draft) || hasSubmittedRef.current) return;
        if (isLast) {
            submitAll();
        } else {
            setIndex((i) => i + 1);
        }
    }, [question, draft, isLast, submitAll]);

    // Skip advances past the current question without an answer (clearing any
    // partial one). On the last question that means sending the response with
    // this question unanswered — built from the cleared draft here, because the
    // state setter has not settled by the time the response goes out.
    const handleSkip = useCallback(() => {
        if (!question || hasSubmittedRef.current) return;
        const cleared = clearAnswer(question, draft);
        setDraft(cleared);
        if (isLast) {
            submitAnswers(buildAnswers(questions, cleared));
        } else {
            setIndex((i) => i + 1);
        }
    }, [question, draft, questions, isLast, submitAnswers]);

    if (!question) return null;

    const selectedIds = draft.selections[question.id] ?? [];
    const isOther = !!draft.otherSelected[question.id];

    return (
        <div
            className="user-message-display"
            style={{ minHeight: 'fit-content' }}
            role="group"
            aria-label={total > 1 ? `Question ${index + 1} of ${total}` : 'Question'}
        >
            <div className="display-flex flex-col gap-15">
                {/* Header: per-question label + stepper. The question's short
                    header ("Topic") is the headline; the call-level title is
                    only a fallback for questions without one. */}
                <div className="display-flex flex-row items-center justify-between gap-2">
                    <div
                        className="font-color-primary text-sm font-semibold uppercase truncate"
                        style={{ letterSpacing: '0.05em' }}
                    >
                        {question.header || pendingQuestion.title || 'Question'}
                    </div>
                    {total > 1 && (
                        <div className="display-flex flex-row items-center gap-1 flex-none">
                            <IconButton
                                icon={ArrowLeftIcon}
                                variant="ghost-secondary"
                                ariaLabel="Previous question"
                                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                                disabled={index === 0 || isSubmitted}
                            />
                            <span className="text-sm font-color-tertiary whitespace-nowrap">
                                {index + 1} of {total}
                            </span>
                            <IconButton
                                icon={ArrowRightIcon}
                                variant="ghost-secondary"
                                ariaLabel="Next question"
                                onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
                                disabled={isLast || isSubmitted}
                            />
                        </div>
                    )}
                </div>

                {/* Question */}
                <div className="display-flex flex-col gap-1 min-w-0">
                    <div className="font-color-primary">
                        {question.question}
                        {question.allow_multiple && (
                            <span className="font-color-secondary text-base ml-2">
                                (Multiple choice)
                            </span>
                        )}
                    </div>

                    <div className="display-flex flex-col gap-05 items-start mt-1 min-w-0">
                        {question.options.map((option) => {
                            const isSelected = selectedIds.includes(option.id);
                            return (
                                <Button
                                    key={option.id}
                                    variant='ghost-secondary'
                                    className="text-left w-full"
                                    onClick={() => handleOptionClick(question, option.id)}
                                    aria-pressed={isSelected}
                                    disabled={isSubmitted}
                                    style={{ padding: '3px 6px' }}
                                >
                                    <span className="display-flex flex-row gap-2 items-start min-w-0">
                                        <Icon
                                            icon={isSelected ? CheckmarkCircleSolidIcon : CircleIcon}
                                            className={`mt-020 scale-12 ${isSelected ? 'font-color-accent-green' : 'font-color-secondary'}`}
                                        />
                                        <span className="min-w-0 display-flex flex-col gap-05">
                                            <span className="font-color-primary text-base">{option.label}</span>
                                            {option.description && (
                                                <span className="font-color-secondary text-base">
                                                    {option.description}
                                                </span>
                                            )}
                                        </span>
                                    </span>
                                </Button>
                            );
                        })}

                        {/* "Other" — an inline option row: toggle icon + the
                            free-text field on one line. Clicking the icon
                            selects Other and focuses the field; focusing or
                            typing in the field selects Other. The row mirrors
                            an option row's geometry and selected styling. */}
                        {allowsCustomAnswer(question) && (
                            <div
                                className="display-flex flex-row gap-2 items-start w-full min-w-0"
                                style={{ padding: '3px 6px', }}
                            >
                                <button
                                    type="button"
                                    aria-pressed={isOther}
                                    aria-label="Other (custom answer)"
                                    disabled={isSubmitted}
                                    onClick={() => handleOtherClick(question)}
                                    className="display-flex mt-15"
                                    style={{
                                        background: 'transparent',
                                        border: 0,
                                        padding: 0,
                                        cursor: 'pointer',
                                        // Match the option rows' icon size (they
                                        // inherit the button variant's 0.9rem).
                                        fontSize: '0.9rem',
                                    }}
                                >
                                    <Icon
                                        icon={isOther ? CheckmarkCircleSolidIcon : CircleIcon}
                                        className={`scale-12 ${isOther ? 'font-color-accent-green' : 'font-color-secondary'}`}
                                    />
                                </button>
                                <textarea
                                    ref={textareaRef}
                                    className="chat-input"
                                    rows={1}
                                    placeholder="Other..."
                                    aria-label={`Custom answer for: ${question.question}`}
                                    value={draft.customTexts[question.id] ?? ''}
                                    disabled={isSubmitted}
                                    style={{ flex: 1 }}
                                    onFocus={() => setDraft((prev) => selectOther(question, prev))}
                                    onChange={(e) => {
                                        const text = e.target.value;
                                        setDraft((prev) => setCustomText(question, text, prev));
                                    }}
                                    onInput={(e) => {
                                        e.currentTarget.style.height = 'auto';
                                        e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            handleNext();
                                        }
                                    }}
                                />
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer: Stop ... Skip Next/Submit */}
                <div className="display-flex flex-row items-center pt-2 gap-2">
                    <Tooltip content="Stop the agent run" showArrow singleLine>
                        <Button
                            variant="outline"
                            rightIcon={StopStrokeIcon}
                            ariaLabel="Stop generating"
                            style={{ padding: '2px 5px' }}
                            onClick={onStop}
                        >
                            Stop
                        </Button>
                    </Tooltip>
                    <div className="flex-1" />
                    <Button
                        variant="ghost"
                        ariaLabel={isLast ? 'Skip this question and submit' : 'Skip this question'}
                        onClick={handleSkip}
                        disabled={isSubmitted}
                    >
                        Skip
                    </Button>
                    <Button
                        variant="solid"
                        ariaLabel={isLast ? 'Submit answers' : 'Next question'}
                        style={{ padding: '2px 5px' }}
                        onClick={handleNext}
                        disabled={!isQuestionAnswered(question, draft) || isSubmitted}
                    >
                        {isLast
                            ? (<span>Submit <span className="opacity-50">⏎</span></span>)
                            : (<span>Next <span className="opacity-50">⏎</span></span>)}
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default AskUserQuestionCard;
