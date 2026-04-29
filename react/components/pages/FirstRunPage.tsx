import React, { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    firstRunSuggestionsAtom,
    firstRunSuggestionsLoadingAtom,
    loadFirstRunSuggestionsAtom,
    refreshFirstRunSuggestionsAtom,
    firstRunReturnRequestedAtom,
} from '../../atoms/firstRun';
import { remainingBeaverCreditsAtom } from '../../atoms/profile';
import SuggestionCardButton from './firstRun/SuggestionCardButton';
import SuggestionCardSkeleton from './firstRun/SuggestionCardSkeleton';
import IconButton from '../ui/IconButton';
import SyncIcon from '../icons/SyncIcon';
import { OnboardingHeader, OnboardingFooter } from './onboarding';

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

    useEffect(() => {
        void load();
    }, [load]);

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
                <div className="display-flex flex-row items-start justify-between gap-3">
                    <OnboardingHeader message={headerMessage} />
                    {isDev && (
                        <IconButton
                            icon={SyncIcon}
                            variant="ghost-secondary"
                            onClick={() => void refresh()}
                            disabled={isLoading}
                            ariaLabel="Refresh suggestions (dev)"
                        />
                    )}
                </div>

                {/* Intro line */}
                <div className="text-base font-semibold mt-2 mb-3">
                    A few ideas based on your library
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
                onButtonClick={() => setReturnRequested(false)}
            />
        </div>
    );
};

export default FirstRunPage;
