import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import type { PendingQuestion } from '../../agents/pendingQuestions';
import type {
    AskUserQuestionAnswer,
    AskUserQuestionItem,
} from '../../../src/services/agentProtocol';
import {
    closeWSConnectionAtom,
    sendAskUserQuestionResponseAtom,
} from '../../atoms/agentRunAtoms';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import {
    ArrowLeftIcon,
    ArrowRightIcon,
    CheckmarkCircleSolidIcon,
    CircleIcon,
    Icon,
    StopIcon,
} from '../icons/icons';
import { logger } from '../../../src/utils/logger';

interface AskUserQuestionPanelProps {
    pendingQuestion: PendingQuestion;
}

/**
 * Composer takeover for a pending ask_user_question request.
 *
 * Rendered by Sidebar INSTEAD of InputArea while the agent blocks on the
 * user's answer, so the question sits where the user is already looking and
 * cannot be scrolled away. The user's draft message is untouched — this panel
 * never reads or writes currentMessageContentAtom, so the composer restores
 * the draft when it returns.
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
export const AskUserQuestionPanel: React.FC<AskUserQuestionPanelProps> = ({ pendingQuestion }) => {
    const sendResponse = useSetAtom(sendAskUserQuestionResponseAtom);
    const closeWSConnection = useSetAtom(closeWSConnectionAtom);

    const questions = pendingQuestion.questions;
    const total = questions.length;

    const [index, setIndex] = useState(0);
    // Selected option ids / custom text / "Other" selection per question id —
    // preserved across back/forward navigation, sent together on Submit.
    const [selections, setSelections] = useState<Record<string, string[]>>({});
    const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
    const [otherSelected, setOtherSelected] = useState<Record<string, boolean>>({});
    // Guards double-submit in the instant before the panel unmounts.
    const [isSubmitted, setIsSubmitted] = useState(false);

    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const question: AskUserQuestionItem | undefined = questions[Math.min(index, total - 1)];
    const isLast = index >= total - 1;

    const allowsCustom = (q: AskUserQuestionItem) => q.allow_custom ?? true;

    // Custom text counts only while "Other" is selected — an Other selection
    // with nothing typed keeps Next/Submit disabled, and text left behind
    // after deselecting Other neither counts nor gets sent.
    const isAnswered = (q: AskUserQuestionItem) =>
        (selections[q.id]?.length ?? 0) > 0 ||
        (allowsCustom(q) && !!otherSelected[q.id] && (customTexts[q.id]?.trim() ?? '') !== '');

    // Keep the custom-answer field's height fitted to its (per-question)
    // content when the panel appears or the question changes. Deliberately no
    // focus here — the field is only focused when the user picks "Other".
    useEffect(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = `${ta.scrollHeight}px`;
    }, [index]);

    const toggleOption = (q: AskUserQuestionItem, optionId: string) => {
        setSelections((prev) => {
            const current = prev[q.id] ?? [];
            const isSelected = current.includes(optionId);
            if (q.allow_multiple) {
                return {
                    ...prev,
                    [q.id]: isSelected
                        ? current.filter((id) => id !== optionId)
                        : [...current, optionId],
                };
            }
            return { ...prev, [q.id]: isSelected ? [] : [optionId] };
        });
        // Radio semantics: picking a listed option deselects "Other".
        if (!q.allow_multiple) {
            setOtherSelected((prev) => (prev[q.id] ? { ...prev, [q.id]: false } : prev));
        }
        // Move the caret out of the "Other" field when a listed option is
        // picked — refocusing/typing there would re-select Other.
        const ta = textareaRef.current;
        if (ta && ta.ownerDocument.activeElement === ta) ta.blur();
    };

    // Select "Other" (idempotent). Radio semantics: clears the listed
    // selections when the question is single-select. Also invoked from the
    // textarea's focus handler so clicking straight into the text field
    // selects Other without an extra click.
    const selectOther = (q: AskUserQuestionItem) => {
        setOtherSelected((prev) => (prev[q.id] ? prev : { ...prev, [q.id]: true }));
        if (!q.allow_multiple) {
            setSelections((prev) => ((prev[q.id]?.length ?? 0) > 0 ? { ...prev, [q.id]: [] } : prev));
        }
    };

    const handleOtherClick = (q: AskUserQuestionItem) => {
        if (otherSelected[q.id]) {
            setOtherSelected((prev) => ({ ...prev, [q.id]: false }));
        } else {
            selectOther(q);
            textareaRef.current?.focus();
        }
    };

    const submitAll = useCallback((overrides?: { clearQuestionId?: string }) => {
        if (isSubmitted) return;
        setIsSubmitted(true);
        const answers: AskUserQuestionAnswer[] = questions.map((q) => {
            const cleared = overrides?.clearQuestionId === q.id;
            return {
                item_id: q.id,
                selected_option_ids: cleared ? [] : (selections[q.id] ?? []),
                custom_text: cleared || !allowsCustom(q) || !otherSelected[q.id]
                    ? null
                    : (customTexts[q.id]?.trim() || null),
            };
        });
        sendResponse({
            questionId: pendingQuestion.questionId,
            toolcallId: pendingQuestion.toolcallId,
            answers,
            cancelled: false,
        });
    }, [isSubmitted, questions, selections, customTexts, otherSelected, sendResponse, pendingQuestion]);

    const handleNext = useCallback(() => {
        if (!question || !isAnswered(question) || isSubmitted) return;
        if (isLast) {
            submitAll();
        } else {
            setIndex((i) => i + 1);
        }
    }, [question, isLast, isSubmitted, submitAll, selections, customTexts, otherSelected]);

    // Skip advances past the current question without an answer (clearing any
    // partial one). On the last question that means sending the response with
    // this question unanswered.
    const handleSkip = useCallback(() => {
        if (!question || isSubmitted) return;
        setSelections((prev) => ({ ...prev, [question.id]: [] }));
        setCustomTexts((prev) => ({ ...prev, [question.id]: '' }));
        setOtherSelected((prev) => ({ ...prev, [question.id]: false }));
        if (isLast) {
            submitAll({ clearQuestionId: question.id });
        } else {
            setIndex((i) => i + 1);
        }
    }, [question, isLast, isSubmitted, submitAll]);

    const handleStop = useCallback(() => {
        logger('AskUserQuestionPanel: Stopping run while question pending');
        closeWSConnection(); // Also clears pending questions -> panel unmounts
    }, [closeWSConnection]);

    if (!question) return null;

    const selectedIds = selections[question.id] ?? [];
    const isOther = !!otherSelected[question.id];

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
                    <div className="font-color-primary">{question.question}</div>

                    <div className="display-flex flex-col gap-05 items-start mt-1 min-w-0">
                        {question.options.map((option) => {
                            const isSelected = selectedIds.includes(option.id);
                            return (
                                <Button
                                    key={option.id}
                                    variant='ghost-secondary'
                                    className="text-left w-full"
                                    onClick={() => toggleOption(question, option.id)}
                                    aria-pressed={isSelected}
                                    disabled={isSubmitted}
                                    style={{ padding: '3px 6px' }}
                                >
                                    <span className="display-flex flex-row gap-2 items-start min-w-0">
                                        <Icon
                                            icon={isSelected ? CheckmarkCircleSolidIcon : CircleIcon}
                                            className={`mt-020 scale-12 ${isSelected ? 'font-color-accent-green' : 'font-color-secondary'}`}
                                        />
                                        <span className="min-w-0">
                                            <span className="font-color-primary text-base">{option.label}</span>
                                            {option.description && (
                                                <span className="font-color-secondary text-base ml-2">
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
                        {allowsCustom(question) && (
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
                                    value={customTexts[question.id] ?? ''}
                                    disabled={isSubmitted}
                                    style={{ flex: 1 }}
                                    onFocus={() => selectOther(question)}
                                    onChange={(e) => {
                                        selectOther(question);
                                        setCustomTexts((prev) => ({
                                            ...prev,
                                            [question.id]: e.target.value,
                                        }));
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
                            variant="surface"
                            rightIcon={StopIcon}
                            ariaLabel="Stop generating"
                            style={{ padding: '2px 5px' }}
                            onClick={handleStop}
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
                        disabled={!isAnswered(question) || isSubmitted}
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

export default AskUserQuestionPanel;
