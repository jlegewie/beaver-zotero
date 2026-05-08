import React, { useEffect, useRef } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
    EMPTY_LIBRARY_DISCOVER_MAX_LENGTH,
    emptyLibraryDiscoverInputAtom,
    emptyLibraryDiscoverSubmittingAtom,
    submitEmptyLibraryDiscoverAtom,
} from '../../../atoms/firstRun';
import Button from '../../ui/Button';
import { ArrowRightIcon, Spinner } from '../../icons/icons';
import { logger } from '../../../../src/utils/logger';

/**
 * Empty-library first-run experience: research-interest textarea + submit
 * button + example-topic chips. Submitting opens a new thread with web search
 * enabled and runs the discovery prompt; the existing `discover_research`
 * follow-ups (NextStepsPanel) surface "save the top results to a new
 * collection" — which imports items into Zotero, the natural starter step
 * for an empty library.
 */
const EXAMPLE_TOPICS = [
    'Social media and teen mental health',
    'mRNA cancer vaccines',
    'Coral reef restoration',
    'How LLMs hallucinate',
    'Psychedelics for depression',
];

const EmptyLibraryDiscovery: React.FC = () => {
    const [interest, setInterest] = useAtom(emptyLibraryDiscoverInputAtom);
    const isSubmitting = useAtomValue(emptyLibraryDiscoverSubmittingAtom);
    const submit = useSetAtom(submitEmptyLibraryDiscoverAtom);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        textareaRef.current?.focus();
    }, []);

    const trimmed = interest.trim();
    const canSubmit = trimmed.length > 0 && !isSubmitting;

    const handleSubmit = async () => {
        if (!canSubmit) return;
        try {
            await submit();
        } catch (err) {
            logger(`EmptyLibraryDiscovery: submit failed: ${err}`, 1);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Enter submits, Shift+Enter inserts a newline. Mirrors the chat input.
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleSubmit();
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInterest(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = `${e.target.scrollHeight}px`;
    };

    const handleChipClick = (topic: string) => {
        if (isSubmitting) return;
        setInterest(topic);
        textareaRef.current?.focus();
    };

    return (
        <div className="display-flex flex-col gap-4 mt-1">
            <style>
                {`
                .empty-library-discover-input::placeholder {
                    color: var(--fill-secondary);
                    opacity: 1;
                }
                `}
            </style>

            <div className="user-message-display">
                <textarea
                    ref={textareaRef}
                    value={interest}
                    onChange={handleChange}
                    onKeyDown={handleKeyDown}
                    placeholder="Describe what you're researching…"
                    className="chat-input empty-library-discover-input"
                    rows={3}
                    maxLength={EMPTY_LIBRARY_DISCOVER_MAX_LENGTH}
                    disabled={isSubmitting}
                    style={{ minHeight: '72px' }}
                />
            </div>

            <div className="display-flex flex-row items-center justify-center gap-25 flex-wrap">
                {EXAMPLE_TOPICS.map((topic) => (
                    <Button
                        key={topic}
                        variant="surface-light"
                        onClick={() => handleChipClick(topic)}
                        disabled={isSubmitting}
                        className="fit-content"
                        style={{ padding: '2px 8px', fontSize: '0.875rem' }}
                    >
                        {topic}
                    </Button>
                ))}
            </div>

            <div className="display-flex flex-row items-center justify-end mt-1">
                <Button
                    variant="solid"
                    onClick={() => void handleSubmit()}
                    disabled={!canSubmit}
                    rightIcon={isSubmitting ? Spinner : ArrowRightIcon}
                    className="fit-content whitespace-nowrap"
                >
                    Discover papers
                </Button>
            </div>

            {isSubmitting && trimmed.length > 0 && (
                <div className="font-color-secondary text-sm mt-1">
                    Finding recent work on {trimmed}…
                </div>
            )}
        </div>
    );
};

export default EmptyLibraryDiscovery;
