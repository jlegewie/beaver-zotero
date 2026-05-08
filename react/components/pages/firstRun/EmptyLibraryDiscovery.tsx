import React, { useEffect, useRef } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
    EMPTY_LIBRARY_DISCOVER_MAX_LENGTH,
    emptyLibraryDiscoverInputAtom,
    emptyLibraryDiscoverSubmittingAtom,
    submitEmptyLibraryDiscoverAtom,
} from '../../../atoms/firstRun';
import Button from '../../ui/Button';
import { ArrowRightIcon, GlobalSearchIcon, Spinner } from '../../icons/icons';
import { logger } from '../../../../src/utils/logger';

/**
 * Empty-library first-run experience: research-interest textarea + submit
 * button. Submitting opens a new thread with web search enabled and runs the
 * discovery prompt; the existing `discover_research` follow-ups (NextStepsPanel)
 * surface "save the top results to a new collection" — which imports items
 * into Zotero, the natural starter step for an empty library.
 */
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

    return (
        <div className="display-flex flex-col gap-3">
            <div className="display-flex flex-row items-center gap-2 mt-2 mb-1">
                <GlobalSearchIcon width={14} height={14} className="font-color-primary" />
                <div className="text-base font-semibold">
                    Tell us what you&apos;re researching
                </div>
            </div>
            <div className="text-base font-color-secondary mb-1">
                Beaver will find recent, highly-cited papers in your area to get your library started.
            </div>

            <div className="user-message-display">
                <textarea
                    ref={textareaRef}
                    value={interest}
                    onChange={handleChange}
                    onKeyDown={handleKeyDown}
                    placeholder="e.g. machine learning for protein structure prediction"
                    className="chat-input"
                    rows={3}
                    maxLength={EMPTY_LIBRARY_DISCOVER_MAX_LENGTH}
                    disabled={isSubmitting}
                    style={{ minHeight: '80px' }}
                />
            </div>

            <div className="display-flex flex-row items-center justify-end">
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
        </div>
    );
};

export default EmptyLibraryDiscovery;
