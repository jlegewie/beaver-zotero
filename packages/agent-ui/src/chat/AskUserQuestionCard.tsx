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
    setNote,
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
    PlusSignIcon,
    StopStrokeIcon,
} from '../icons';
import { useQuestionCountdown } from './useQuestionCountdown';

const ADD_NOTE_LABEL = 'Add a note';
const NOTE_HEADING = 'Your note';
const NOTE_PLACEHOLDER = 'A note on your choice';
/** Below this the closing time is announced even while touches still refill the window. */
const EXPIRY_WARNING_MS = 15_000;
/** Passive activity (pointer, wheel, keys) refills the window at most this often. */
const PASSIVE_TOUCH_MS = 1_000;

/** "1:25" past a minute, "42s" under it. */
function formatRemaining(ms: number): string {
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Off-screen but read by assistive technology. */
const VISUALLY_HIDDEN: React.CSSProperties = {
    position: 'absolute',
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    border: 0,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
};

export interface AskUserQuestionCardProps {
    /** The request the run is blocked on, as the backend asked it. */
    pendingQuestion: PendingQuestion;
    /** The user's answers for every question of the request. */
    onSubmit: (answers: AskUserQuestionAnswer[]) => void;
    /**
     * The countdown ran out before a submit. Receives whatever the user had
     * answered so far. Optional: a host that does not pace the card (its
     * backend's own tool return retires the question) leaves it out, and the
     * card then runs no clock and draws no countdown.
     */
    onExpire?: (answers: AskUserQuestionAnswer[]) => void;
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
 * one selection, Other with text, or a note). All answers are sent in a
 * single response on Submit — questions skipped along the way go out with
 * empty selections, and a response where every answer is empty is treated as
 * a skip by the backend.
 *
 * Other is a listed option with its own field: the user's own answer when
 * nothing above fits. "Add a note" opens a second field that stands on its
 * own as an answer or qualifies a selected option (including Other). The
 * wire has one `custom_text`, so Other and the note are joined when both
 * are present.
 *
 * With `onExpire`, the card counts down while idle. A hairline along its top
 * edge drains over the idle window and refills on any interaction — clicks and
 * typing, and pointer or key activity over the card at a slower rate — up to
 * the backend's own window; once a touch no longer extends it the bar turns
 * orange, and a live region announces the closing time for readers who cannot
 * see the bar. When it runs out the card expires through `onExpire` with the
 * partial answers, ahead of the backend, so an engaged user is never cut off
 * and an abandoned card does not hold the run for long.
 */
export const AskUserQuestionCard: React.FC<AskUserQuestionCardProps> = ({
    pendingQuestion,
    onSubmit,
    onExpire,
    onStop,
}) => {
    const questions = pendingQuestion.questions;
    const total = questions.length;

    const [index, setIndex] = useState(0);
    // Selected option ids / Other / note per question id — preserved across
    // back/forward navigation, sent together on Submit.
    const [draft, setDraft] = useState<QuestionDraft>(EMPTY_QUESTION_DRAFT);
    // Which questions have their note field open. A question whose note has
    // text is open regardless, so navigating away and back keeps it visible.
    const [noteOpen, setNoteOpen] = useState<Record<string, boolean>>({});
    // Drives the disabled styling in the instant before the card unmounts.
    const [isSubmitted, setIsSubmitted] = useState(false);
    // The guard that actually holds. Exactly one response may leave the
    // client: the run correlates on the question id, and a second one would
    // arrive after the backend stopped listening. The card is still mounted
    // right after the answers go out — the pending entry clears and React
    // re-renders asynchronously — and two of its controls can fire in the same
    // tick, since Enter in the note field submits just as the Submit button
    // does. `isSubmitted` only settles on the next render, so it cannot block
    // the second of them; this ref is set synchronously and does.
    const hasSubmittedRef = useRef(false);

    const otherTextareaRef = useRef<HTMLTextAreaElement>(null);
    const noteTextareaRef = useRef<HTMLTextAreaElement>(null);

    const question: AskUserQuestionItem | undefined = questions[Math.min(index, total - 1)];
    const isLast = index >= total - 1;

    const respond = useCallback((send: (answers: AskUserQuestionAnswer[]) => void, answers: AskUserQuestionAnswer[]) => {
        if (hasSubmittedRef.current) return;
        hasSubmittedRef.current = true;
        setIsSubmitted(true);
        send(answers);
    }, []);

    const submitAnswers = useCallback((answers: AskUserQuestionAnswer[]) => {
        respond(onSubmit, answers);
    }, [respond, onSubmit]);

    // The expiry path goes through the same one-response guard: a submit that
    // lands in the same tick as the deadline must not produce a second message.
    const handleExpire = useCallback(() => {
        if (!onExpire) return;
        respond(onExpire, buildAnswers(questions, draft));
    }, [respond, onExpire, questions, draft]);

    const hasCountdown = !!onExpire;
    const countdown = useQuestionCountdown(pendingQuestion.expiresAt, handleExpire, hasCountdown && !isSubmitted);
    const touch = countdown.touch;

    // Reading is activity too: pointer movement, scrolling and keystrokes over
    // the card refill the window, throttled so a moving mouse does not
    // re-render the card on every event.
    const lastPassiveTouchRef = useRef(0);
    const touchPassively = () => {
        if (!hasCountdown) return;
        const now = Date.now();
        if (now - lastPassiveTouchRef.current < PASSIVE_TOUCH_MS) return;
        lastPassiveTouchRef.current = now;
        touch();
    };

    // The note field takes the caret when the user opens it, and only then:
    // it also remounts when they step back to a question whose note is open,
    // and stealing focus from the options there would be wrong.
    const wantsNoteFocusRef = useRef(false);
    useEffect(() => {
        if (!wantsNoteFocusRef.current) return;
        wantsNoteFocusRef.current = false;
        noteTextareaRef.current?.focus();
    });

    // Keep the Other and note fields' height fitted to their (per-question)
    // content when the card appears or the question changes. Deliberately no
    // focus here — Other is only focused when the user picks it, and the
    // note field focuses itself when opened.
    useEffect(() => {
        for (const ta of [otherTextareaRef.current, noteTextareaRef.current]) {
            if (!ta) continue;
            ta.style.height = 'auto';
            ta.style.height = `${ta.scrollHeight}px`;
        }
    }, [index]);

    const handleOptionClick = (q: AskUserQuestionItem, optionId: string) => {
        touch();
        setDraft((prev) => toggleOption(q, optionId, prev));
        // Move the caret out of the Other field when a listed option is
        // picked — refocusing/typing there would re-select Other.
        const ta = otherTextareaRef.current;
        if (ta && ta.ownerDocument.activeElement === ta) ta.blur();
    };

    const handleOtherClick = (q: AskUserQuestionItem) => {
        touch();
        const wasSelected = !!draft.otherSelected[q.id];
        setDraft((prev) => toggleOther(q, prev));
        if (!wasSelected) otherTextareaRef.current?.focus();
    };

    const handleOpenNote = (q: AskUserQuestionItem) => {
        touch();
        wantsNoteFocusRef.current = true;
        setNoteOpen((prev) => ({ ...prev, [q.id]: true }));
    };

    const submitAll = useCallback(() => {
        submitAnswers(buildAnswers(questions, draft));
    }, [submitAnswers, questions, draft]);

    const handleNext = useCallback(() => {
        if (!question || !isQuestionAnswered(question, draft) || hasSubmittedRef.current) return;
        touch();
        if (isLast) {
            submitAll();
        } else {
            setIndex((i) => i + 1);
        }
    }, [question, draft, isLast, submitAll, touch]);

    // Skip advances past the current question without an answer (clearing any
    // partial one). On the last question that means sending the response with
    // this question unanswered — built from the cleared draft here, because the
    // state setter has not settled by the time the response goes out.
    const handleSkip = useCallback(() => {
        if (!question || hasSubmittedRef.current) return;
        touch();
        const cleared = clearAnswer(question, draft);
        setDraft(cleared);
        if (isLast) {
            submitAnswers(buildAnswers(questions, cleared));
        } else {
            setIndex((i) => i + 1);
        }
    }, [question, draft, questions, isLast, submitAnswers, touch]);

    const step = (delta: number) => {
        touch();
        setIndex((i) => Math.max(0, Math.min(total - 1, i + delta)));
    };

    if (!question) return null;

    const selectedIds = draft.selections[question.id] ?? [];
    const isOther = !!draft.otherSelected[question.id];
    const noteValue = draft.notes[question.id] ?? '';
    const showNote = allowsCustomAnswer(question) && (!!noteOpen[question.id] || noteValue.trim() !== '');
    // Orange once engaging no longer helps. The closing time is announced (not
    // shown) from then on, and in the last seconds of an ordinary idle window.
    const isCapped = hasCountdown && !isSubmitted && countdown.capped;
    const announceRemaining = isCapped || (hasCountdown && !isSubmitted && countdown.remainingMs < EXPIRY_WARNING_MS);

    return (
        <div
            className="user-message-display"
            style={{ minHeight: 'fit-content', position: 'relative' }}
            role="group"
            aria-label={total > 1 ? `Question ${index + 1} of ${total}` : 'Question'}
            onPointerMove={touchPassively}
            onWheel={touchPassively}
            onKeyDown={touchPassively}
            onFocus={touchPassively}
        >
            {/* Idle countdown: drains across the top edge, refills on
                interaction, turns orange once the backend's window caps it.
                The strip sits in an overlay that covers the card and clips to
                the card radius (inside its 1px border) — a radius on the 2px
                strip itself would shrink to its height and leave square
                corners, and clipping the card itself would clip the Stop
                tooltip. The overlay takes no pointer events. */}
            {hasCountdown && (
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        borderRadius: 'calc(var(--beaver-radius-card) - 1px)',
                        overflow: 'hidden',
                        pointerEvents: 'none',
                    }}
                    aria-hidden={isSubmitted}
                >
                    <div
                        className="batch-progress-hairline"
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            height: 2,
                            opacity: isSubmitted ? 0 : 1,
                            transition: 'opacity 0.4s ease',
                        }}
                        role="timer"
                        aria-label="Time left to answer"
                    >
                        <div
                            style={{
                                height: '100%',
                                width: `${Math.round(countdown.fraction * 1000) / 10}%`,
                                backgroundColor: isCapped ? 'var(--tag-orange)' : 'var(--accent-blue)',
                                transition: 'width 0.25s linear, background-color 0.4s ease',
                            }}
                        />
                    </div>
                </div>
            )}
            {/* The bar is the only visible countdown; this is what a screen
                reader gets instead. Polite, and only once the end is near, so
                it does not talk over the question itself. */}
            {announceRemaining && (
                <span style={VISUALLY_HIDDEN} aria-live="polite" role="status">
                    {isCapped
                        ? `This question closes in ${formatRemaining(countdown.remainingMs)}; interacting no longer extends it.`
                        : `This question closes in ${formatRemaining(countdown.remainingMs)} unless you interact with it.`}
                </span>
            )}

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
                                onClick={() => step(-1)}
                                disabled={index === 0 || isSubmitted}
                            />
                            <span className="text-sm font-color-tertiary whitespace-nowrap">
                                {index + 1} of {total}
                            </span>
                            <IconButton
                                icon={ArrowRightIcon}
                                variant="ghost-secondary"
                                ariaLabel="Next question"
                                onClick={() => step(1)}
                                disabled={isLast || isSubmitted}
                            />
                        </div>
                    )}
                </div>

                {/* Question */}
                <div className="display-flex flex-col gap-3 min-w-0">
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
                                    ref={otherTextareaRef}
                                    className="chat-input"
                                    rows={1}
                                    placeholder="Other..."
                                    aria-label={`Custom answer for: ${question.question}`}
                                    value={draft.customTexts[question.id] ?? ''}
                                    disabled={isSubmitted}
                                    style={{ flex: 1 }}
                                    onFocus={() => {
                                        touch();
                                        setDraft((prev) => selectOther(question, prev));
                                    }}
                                    onChange={(e) => {
                                        touch();
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

                    {/* The note: opened on demand like the batch card's
                        instructions. Independent of the selection and Other,
                        so it works both as "this one, but ..." and as a
                        qualifier on an Other answer. */}
                    {allowsCustomAnswer(question) && (
                        showNote ? (
                            <div className="display-flex flex-col min-w-0 gap-05 mt-1">
                                <div
                                    className="text-sm font-semibold uppercase font-color-secondary"
                                    style={{ letterSpacing: '0.06em' }}
                                >
                                    {NOTE_HEADING}
                                </div>
                                <textarea
                                    ref={noteTextareaRef}
                                    className="chat-input"
                                    rows={1}
                                    placeholder={NOTE_PLACEHOLDER}
                                    aria-label={`Note for: ${question.question}`}
                                    value={noteValue}
                                    disabled={isSubmitted}
                                    onChange={(e) => {
                                        touch();
                                        const text = e.target.value;
                                        setDraft((prev) => setNote(question, text, prev));
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
                        ) : (
                            <Button
                                variant="ghost"
                                icon={PlusSignIcon}
                                ariaLabel="Add a note"
                                // Pulled back by its own padding so the label
                                // lines up with the options above it.
                                style={{ alignSelf: 'flex-start', marginLeft: '-2px', fontSize: '1rem' }}
                                disabled={isSubmitted}
                                onClick={() => handleOpenNote(question)}
                            >
                                {ADD_NOTE_LABEL}
                            </Button>
                        )
                    )}
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
