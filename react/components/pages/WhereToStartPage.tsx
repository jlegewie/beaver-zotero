import React, { useEffect, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
    whereToStartOptionsAtom,
    whereToStartLoadingAtom,
    whereToStartSelectedActionIdAtom,
    whereToStartTopicAtom,
    whereToStartSubmittingAtom,
    canStartWhereToStartAtom,
    loadWhereToStartOptionsAtom,
    selectStartOptionAtom,
    startSelectedOptionAtom,
    skipWhereToStartAtom,
    StartOption,
} from '../../atoms/whereToStart';
import { libraryItemCountAtom } from '../../atoms/zoteroContext';
import { OnboardingFooter } from './onboarding';
import { logger } from '../../../src/utils/logger';

/**
 * "Where should we start?" action launcher. The user selects a curated
 * built-in action derived from local library signals; topic-based actions
 * reveal an inline textarea before launch.
 */

const TOPIC_MAX_LENGTH = 500;

interface StartOptionRowProps {
    index: number;
    option: StartOption;
    isSelected: boolean;
    topic: string;
    disabled: boolean;
    onSelect: () => void;
    onTopicChange: (value: string) => void;
    onStart: () => void;
}

const StartOptionRow: React.FC<StartOptionRowProps> = ({
    index,
    option,
    isSelected,
    topic,
    disabled,
    onSelect,
    onTopicChange,
    onStart,
}) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const showTopicInput = isSelected && option.requiresTopic;

    // Focus the topic field when an input-required option is selected.
    useEffect(() => {
        if (showTopicInput) textareaRef.current?.focus();
    }, [showTopicInput]);

    const handleRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            // A no-input option that is already selected starts on Enter; any
            // other case just (re)selects the row.
            if (isSelected && !option.requiresTopic) onStart();
            else onSelect();
        }
    };

    const handleTopicKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Enter starts the run, Shift+Enter inserts a newline (like the chat input).
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onStart();
        }
    };

    const handleTopicChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        onTopicChange(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = `${e.target.scrollHeight}px`;
    };

    return (
        <div
            role="button"
            tabIndex={0}
            aria-pressed={isSelected}
            onClick={onSelect}
            onKeyDown={handleRowKeyDown}
            className={`where-to-start-row display-flex flex-row items-start gap-3 cursor-pointer${isSelected ? ' where-to-start-row-selected' : ''}`}
        >
            <div className="where-to-start-badge display-flex items-center justify-center font-color-secondary text-base">
                {index}
            </div>
            <div className="display-flex flex-col min-w-0 flex-1 where-to-start-row-copy">
                <div className="where-to-start-option-title font-semibold">{option.title}</div>
                {option.description && (
                    <div className="where-to-start-option-description font-color-secondary">{option.description}</div>
                )}
                {showTopicInput && (
                    <div className="where-to-start-topic-wrap user-message-display" onClick={(e) => e.stopPropagation()}>
                        <textarea
                            ref={textareaRef}
                            value={topic}
                            onChange={handleTopicChange}
                            onKeyDown={handleTopicKeyDown}
                            placeholder={option.argumentHintPlaceholder}
                            className="chat-input"
                            rows={2}
                            maxLength={TOPIC_MAX_LENGTH}
                            disabled={disabled}
                        />
                    </div>
                )}
            </div>
        </div>
    );
};

const WhereToStartPage: React.FC = () => {
    const options = useAtomValue(whereToStartOptionsAtom);
    const isLoading = useAtomValue(whereToStartLoadingAtom);
    const selectedActionId = useAtomValue(whereToStartSelectedActionIdAtom);
    const [topic, setTopic] = useAtom(whereToStartTopicAtom);
    const isSubmitting = useAtomValue(whereToStartSubmittingAtom);
    const canStart = useAtomValue(canStartWhereToStartAtom);
    const load = useSetAtom(loadWhereToStartOptionsAtom);
    const select = useSetAtom(selectStartOptionAtom);
    const start = useSetAtom(startSelectedOptionAtom);
    const skip = useSetAtom(skipWhereToStartAtom);
    const libraryItemCount = useAtomValue(libraryItemCountAtom);
    const [isSkipping, setIsSkipping] = useState(false);
    const [footerError, setFooterError] = useState<string | null>(null);

    // Re-run the loader once the library-count probe resolves so empty-library
    // detection (and the color-code target lookup) runs against a known count
    // rather than the pending `null` state.
    useEffect(() => {
        void load();
    }, [load, libraryItemCount]);

    const showLoading = isLoading || options === null;

    const handleStart = async () => {
        setFooterError(null);
        try {
            await start();
        } catch (err) {
            logger(`WhereToStartPage: start failed: ${err}`, 1);
            setFooterError('Failed to start. Please try again.');
        }
    };

    const handleSkip = async () => {
        if (isSkipping) return;
        setIsSkipping(true);
        setFooterError(null);
        try {
            await skip();
        } catch (err) {
            logger(`WhereToStartPage: skip failed: ${err}`, 1);
            setFooterError('Failed to connect to Beaver. Please try again.');
        } finally {
            setIsSkipping(false);
        }
    };

    return (
        <div className="where-to-start-page display-flex flex-col flex-1 min-h-0 min-w-0">
            <style>
                {`
                .where-to-start-page {
                    background: var(--material-sidepane);
                }
                .where-to-start-scroll {
                    padding: 18px 18px 12px;
                }
                .where-to-start-shell {
                    width: 100%;
                    max-width: 560px;
                    margin: 0 auto;
                }
                .where-to-start-heading {
                    text-align: center;
                    margin: 4px 0 18px;
                }
                .where-to-start-title {
                    font-size: 2rem;
                    line-height: 1.08;
                    font-weight: 700;
                    letter-spacing: 0;
                    color: var(--fill-primary);
                    margin-bottom: 10px;
                }
                .where-to-start-subtitle {
                    font-size: 1.1rem;
                    line-height: 1.35;
                    color: var(--fill-secondary);
                }
                .where-to-start-card {
                    background: var(--material-sidepane);
                    border: 1px solid var(--fill-quarternary);
                    border-radius: 18px;
                    box-shadow: 0 10px 24px rgba(0,0,0,0.06);
                    padding: 16px;
                }
                .where-to-start-options {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .where-to-start-row {
                    padding: 12px 12px;
                    border-radius: 10px;
                    border: 1px solid transparent;
                    transition: background-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
                }
                .where-to-start-row:hover {
                    background-color: var(--fill-quinary);
                    transform: translateY(-1px);
                    box-shadow: 0 4px 10px rgba(0,0,0,0.06);
                }
                .where-to-start-row:active {
                    transform: translateY(0);
                    box-shadow: none;
                }
                .where-to-start-row:focus-visible {
                    outline: 2px solid var(--fill-quarternary);
                    outline-offset: 2px;
                }
                .where-to-start-row-selected,
                .where-to-start-row-selected:hover {
                    background-color: var(--fill-quinary);
                    border-color: var(--fill-quarternary);
                    transform: none;
                    box-shadow: none;
                }
                .where-to-start-badge {
                    flex: 0 0 auto;
                    width: 24px;
                    height: 24px;
                    border-radius: 8px;
                    background-color: var(--fill-quinary);
                    font-size: 0.95rem;
                    margin-top: 1px;
                }
                .where-to-start-row-selected .where-to-start-badge {
                    background-color: var(--tag-blue-quarternary);
                    color: var(--tag-blue-primary) !important;
                    font-weight: 600;
                }
                .where-to-start-row-copy {
                    gap: 4px;
                }
                .where-to-start-option-title {
                    font-size: 1.05rem;
                    line-height: 1.25;
                    color: var(--fill-primary);
                }
                .where-to-start-option-description {
                    font-size: 0.98rem;
                    line-height: 1.35;
                }
                .where-to-start-topic-wrap {
                    margin-top: 10px;
                }
                .where-to-start-loader {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .where-to-start-loader-row {
                    height: 56px;
                    border-radius: 10px;
                    background: var(--fill-quinary);
                    opacity: 0.72;
                }
                @media (max-width: 520px) {
                    .where-to-start-scroll {
                        padding: 16px 14px 10px;
                    }
                    .where-to-start-heading {
                        text-align: left;
                        margin-bottom: 14px;
                    }
                    .where-to-start-title {
                        font-size: 1.75rem;
                    }
                    .where-to-start-card {
                        padding: 12px;
                    }
                    .where-to-start-row {
                        padding: 11px 8px;
                    }
                    .where-to-start-option-title {
                        font-size: 1rem;
                    }
                    .where-to-start-option-description {
                        font-size: 0.95rem;
                    }
                }
                `}
            </style>

            <div className="where-to-start-scroll overflow-y-auto scrollbar flex-1 min-h-0">
                <div className="where-to-start-shell">
                    {/* Top spacer */}
                    <div className="flex-1" style={{ minHeight: '4vh', maxHeight: '6vh' }} />
                    
                    {/* Heading */}
                    <div className="where-to-start-heading">
                        <div className="where-to-start-title">Let's dig into your library</div>
                        <div className="where-to-start-subtitle">Here are a few good places to start.</div>
                    </div>

                    {/* Options */}
                    <div className="where-to-start-card">
                        {showLoading ? (
                            <div className="where-to-start-loader" aria-label="Loading starting points">
                                <div className="where-to-start-loader-row" />
                                <div className="where-to-start-loader-row" />
                                <div className="where-to-start-loader-row" />
                            </div>
                        ) : options.length === 0 ? (
                            <div className="font-color-secondary text-base p-3">
                                No starting points available.
                            </div>
                        ) : (
                            <div className="where-to-start-options" aria-label="First task options">
                                {options.map((opt, i) => (
                                    <StartOptionRow
                                        key={opt.actionId}
                                        index={i + 1}
                                        option={opt}
                                        isSelected={selectedActionId === opt.actionId}
                                        topic={topic}
                                        disabled={isSubmitting || isSkipping}
                                        onSelect={() => select(opt.actionId)}
                                        onTopicChange={setTopic}
                                        onStart={() => void handleStart()}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <OnboardingFooter
                message={footerError ?? undefined}
                buttonLabel="Start"
                onButtonClick={() => void handleStart()}
                isLoading={isSubmitting}
                disabled={!canStart || isSkipping}
                showBackButton
                onBackClick={() => void handleSkip()}
                backButtonLabel="Skip"
                backButtonDisabled={isSubmitting || isSkipping}
                backButtonLoading={isSkipping}
                hideBackIcon
            />
        </div>
    );
};

export default WhereToStartPage;
