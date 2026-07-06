import React, { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    firstRunSuggestionsAtom,
    firstRunSuggestionsLoadingAtom,
    firstRunSuggestionsErrorAtom,
    firstRunLibraryEmptyAtom,
    loadFirstRunSuggestionsAtom,
    refreshFirstRunSuggestionsAtom,
    firstRunReturnRequestedAtom,
    firstRunSuggestionsModeAtom,
    markFirstRunCompleteAtom,
    padWithFallbackCards,
    MAX_VISIBLE_FIRST_RUN_CARDS,
} from '../../atoms/firstRun';
import { libraryItemCountAtom } from '../../atoms/zoteroContext';
import { remainingBeaverCreditsAtom } from '../../atoms/profile';
import SuggestionCardButton from './firstRun/SuggestionCardButton';
import SuggestionCardSkeleton from './firstRun/SuggestionCardSkeleton';
import EmptyLibraryDiscovery from './firstRun/EmptyLibraryDiscovery';
import IconButton from '../ui/IconButton';
import RepeatIcon from '../icons/RepeatIcon';
import { OnboardingHeader, OnboardingFooter } from './onboarding';
import { ChargingPermissions } from '../../../src/services/agentProtocol';
import { logger } from '../../../src/utils/logger';

// Suggested first-run actions launch without cost-confirmation prompts.
const FIRST_RUN_PERMISSIONS_OVERRIDE: Partial<ChargingPermissions> = {
    confirm_extraction_costs: false,
    confirm_external_search_costs: false,
};

interface FirstRunPageProps {
    isWindow?: boolean;
    inputRef: React.RefObject<HTMLElement | null>;
}

const isDev = process.env.NODE_ENV === 'development';

const FirstRunPage: React.FC<FirstRunPageProps> = () => {
    const suggestions = useAtomValue(firstRunSuggestionsAtom);
    const isLoading = useAtomValue(firstRunSuggestionsLoadingAtom);
    const error = useAtomValue(firstRunSuggestionsErrorAtom);
    const isLibraryEmpty = useAtomValue(firstRunLibraryEmptyAtom);
    const libraryItemCount = useAtomValue(libraryItemCountAtom);
    const remainingCredits = useAtomValue(remainingBeaverCreditsAtom);
    const isSuggestionsMode = useAtomValue(firstRunSuggestionsModeAtom);
    const load = useSetAtom(loadFirstRunSuggestionsAtom);
    const refresh = useSetAtom(refreshFirstRunSuggestionsAtom);
    const setReturnRequested = useSetAtom(firstRunReturnRequestedAtom);
    const setSuggestionsMode = useSetAtom(firstRunSuggestionsModeAtom);
    const markComplete = useSetAtom(markFirstRunCompleteAtom);
    const [isCompleting, setIsCompleting] = useState(false);
    const [footerError, setFooterError] = useState<string | null>(null);

    // Re-run the loader when the library item count changes so a small- or
    // empty-library user who imports more items transitions from the
    // discovery textarea into the regular suggestion-card flow once the
    // count crosses `SMALL_LIBRARY_THRESHOLD`. The count atom is clamped at
    // the threshold so this dependency stops firing once we cross it.
    useEffect(() => {
        void load();
    }, [load, libraryItemCount]);

    const handleFooterClick = async () => {
        if (isCompleting) return;
        setIsCompleting(true);
        setFooterError(null);
        try {
            // Suggestions-mode visits are already completed and only clear the
            // session-level return flags.
            if (!isSuggestionsMode) {
                await markComplete(isLibraryEmpty ? 'empty_library_continue' : 'skip');
            }
            setSuggestionsMode(false);
            setReturnRequested(false);
        } catch (err) {
            logger(`FirstRunPage: complete failed: ${err}`, 1);
            setFooterError(
                "Failed to connect to Beaver. Please try again.",
            );
        } finally {
            setIsCompleting(false);
        }
    };

    const backendCards = suggestions?.cards ?? [];
    const isWaitingForLibraryProbe = libraryItemCount === null;
    const showSkeletons = !isLibraryEmpty && (isWaitingForLibraryProbe || isLoading) && backendCards.length === 0;
    const useFallback = !isLibraryEmpty && !isLoading && (!!error || backendCards.length < 3);
    const cards = (useFallback ? padWithFallbackCards(backendCards) : backendCards)
        .slice(0, MAX_VISIBLE_FIRST_RUN_CARDS);

    const headerMessage = isSuggestionsMode ? (
        <div className="display-flex flex-col gap-2 py-2 mt-3">
            <div className="text-lg font-semibold">Ideas for your library</div>
        </div>
    ) : isLibraryEmpty ? (
        <div className="display-flex flex-col gap-2 py-2 mt-2">
            <div>Tell us what you&apos;re researching and we&apos;ll find recent, highly-cited papers to start your library.</div>
        </div>
    ) : (
        <div className="display-flex flex-col gap-2 py-2 mt-3">
            <div className="text-lg font-semibold">Your AI research assistant in Zotero</div>
            <div>Search across your library, read papers faster, compare findings, and discover relevant new research.</div>
        </div>
    );

    const footerLabel = isSuggestionsMode
        ? 'Cancel'
        : isLibraryEmpty ? 'Skip for now' : 'Skip';
    // Empty-library skip is a secondary path — the primary CTA lives inside
    // EmptyLibraryDiscovery. Other onboarding screens keep the solid default.
    const footerButtonVariant = !isSuggestionsMode && isLibraryEmpty ? 'ghost' : 'solid';

    return (
        <div
            id="first-run-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0"
        >
            {/* Scrollable content area */}
            <div className="overflow-y-auto scrollbar flex-1 p-4 mr-1 display-flex flex-col">
                {/* Header */}
                <OnboardingHeader message={headerMessage} />

                {/* Intro line — only for the suggestion-card path. The empty-library
                    branch renders its own header inside EmptyLibraryDiscovery. */}
                {!isSuggestionsMode && !isLibraryEmpty && (
                    <div className="display-flex flex-row items-center justify-between gap-4">
                        <div className="text-base font-semibold mt-2 mb-3">
                            A few ideas based on your library
                        </div>
                        {isDev && (
                            <IconButton
                                icon={RepeatIcon}
                                variant="ghost-secondary"
                                onClick={() => void refresh()}
                                disabled={isLoading}
                                ariaLabel="Refresh suggestions (dev)"
                            />
                        )}
                    </div>
                )}

                {isLibraryEmpty ? (
                    <EmptyLibraryDiscovery />
                ) : (
                    <div className="display-flex flex-col gap-4">
                        {showSkeletons && (
                            <>
                                <SuggestionCardSkeleton />
                                <SuggestionCardSkeleton />
                                <SuggestionCardSkeleton />
                            </>
                        )}
                        {!showSkeletons && cards.map((card) => (
                            <SuggestionCardButton
                                key={`${card.kind}-${card.slot_index}`}
                                card={card}
                                permissionsOverride={isSuggestionsMode ? undefined : FIRST_RUN_PERMISSIONS_OVERRIDE}
                            />
                        ))}
                    </div>
                )}
            </div>



            {/* Footer */}
            <OnboardingFooter
                // message={remainingCredits > 0 ? `${remainingCredits} credits to start` : undefined}
                message={footerError ? footerError : undefined}
                buttonLabel={footerLabel}
                onButtonClick={handleFooterClick}
                isLoading={isWaitingForLibraryProbe || (isLoading && !isLibraryEmpty) || isCompleting}
                disabled={isWaitingForLibraryProbe || isCompleting}
                buttonVariant={footerButtonVariant}
                hideRightIcon={footerButtonVariant === 'ghost'}
            />
        </div>
    );
};

export default FirstRunPage;
