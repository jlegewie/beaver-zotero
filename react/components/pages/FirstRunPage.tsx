import React, { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    firstRunSuggestionsAtom,
    firstRunSuggestionsLoadingAtom,
    loadFirstRunSuggestionsAtom,
    refreshFirstRunSuggestionsAtom,
    firstRunReturnRequestedAtom,
    markFirstRunCompleteAtom,
} from '../../atoms/firstRun';
import { remainingBeaverCreditsAtom } from '../../atoms/profile';
import SuggestionCardButton from './firstRun/SuggestionCardButton';
import SuggestionCardSkeleton from './firstRun/SuggestionCardSkeleton';
import IconButton from '../ui/IconButton';
import RepeatIcon from '../icons/RepeatIcon';
import { OnboardingHeader, OnboardingFooter } from './onboarding';
import { logger } from '../../../src/utils/logger';

interface FirstRunPageProps {
    isWindow?: boolean;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

const isDev = process.env.NODE_ENV === 'development';

const FirstRunPage: React.FC<FirstRunPageProps> = () => {
    const suggestions = useAtomValue(firstRunSuggestionsAtom);
    const isLoading = useAtomValue(firstRunSuggestionsLoadingAtom);
    const remainingCredits = useAtomValue(remainingBeaverCreditsAtom);
    const load = useSetAtom(loadFirstRunSuggestionsAtom);
    const refresh = useSetAtom(refreshFirstRunSuggestionsAtom);
    const setReturnRequested = useSetAtom(firstRunReturnRequestedAtom);
    const markComplete = useSetAtom(markFirstRunCompleteAtom);
    const [isSkipping, setIsSkipping] = useState(false);

    useEffect(() => {
        void load();
    }, [load]);

    const handleSkip = async () => {
        if (isSkipping) return;
        setIsSkipping(true);
        try {
            await markComplete('skip');
            // Routing will fall through to HomePage on next render once
            // first_run_completed_at is set on the profile.
            setReturnRequested(false);
        } catch (err) {
            logger(`FirstRunPage: Skip failed: ${err}`, 1);
            // Stay on the page; user can retry.
        } finally {
            setIsSkipping(false);
        }
    };

    const cards = suggestions?.cards ?? [];
    const showSkeletons = isLoading && cards.length === 0;

    const headerMessage = (
        <div className="display-flex flex-col gap-2 py-2 mt-3">
            <div className="text-lg font-semibold">Your AI research assistant in Zotero</div>
            <div>Search across your library, read papers faster, compare findings, and discover relevant new research.</div>
        </div>
    );

    return (
        <div
            id="first-run-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0"
        >
            {/* Scrollable content area */}
            <div className="overflow-y-auto scrollbar flex-1 p-4 mr-1 display-flex flex-col">
                {/* Header */}
                <OnboardingHeader message={headerMessage} />

                {/* Intro line */}
                <div className="display-flex flex-row items-center justify-between gap-3">
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
                
                {/* Cards */}
                <div className="display-flex flex-col gap-3">
                    {showSkeletons && (
                        <>
                            <SuggestionCardSkeleton />
                            <SuggestionCardSkeleton />
                            <SuggestionCardSkeleton />
                        </>
                    )}
                    {!showSkeletons && cards.map((card) => (
                        <SuggestionCardButton key={`${card.kind}-${card.slot_index}`} card={card} />
                    ))}
                </div>
            </div>

            {/* Footer */}
            <OnboardingFooter
                message={remainingCredits > 0 ? `${remainingCredits} credits to start` : undefined}
                buttonLabel="Skip"
                onButtonClick={handleSkip}
                isLoading={isLoading || isSkipping}
                disabled={isSkipping}
            />
        </div>
    );
};

export default FirstRunPage;
