import React, { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    firstRunSuggestionsAtom,
    firstRunSuggestionsLoadingAtom,
    firstRunSuggestionsErrorAtom,
    loadFirstRunSuggestionsAtom,
    refreshFirstRunSuggestionsAtom,
} from '../../atoms/firstRun';
import { remainingBeaverCreditsAtom } from '../../atoms/profile';
import InputArea from '../input/InputArea';
import DragDropWrapper from '../input/DragDropWrapper';
import SuggestionCardButton from './firstRun/SuggestionCardButton';
import SuggestionCardSkeleton from './firstRun/SuggestionCardSkeleton';
import IconButton from '../ui/IconButton';
import SyncIcon from '../icons/SyncIcon';

interface FirstRunPageProps {
    isWindow?: boolean;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

const isDev = process.env.NODE_ENV === 'development';

function getIntroLine(opts: {
    isLoading: boolean;
    cardCount: number;
    librarySize: number;
    hasError: boolean;
}): string {
    const { isLoading, cardCount, librarySize, hasError } = opts;
    if (isLoading) {
        return 'Looking through your library to find a few good starting points…';
    }
    if (hasError) {
        return "Couldn't load personalized suggestions. Ask me anything below to get started.";
    }
    if (cardCount === 3) {
        return 'I took a quick look at your library. Here are three things you can try:';
    }
    if (cardCount === 2) {
        return 'I took a quick look at your library. Here are two things you can try:';
    }
    if (cardCount === 1) {
        return "I took a quick look at your library. Here's a starting point you can try:";
    }
    if (librarySize === 0) {
        return "Beaver works best with papers in your library. Add some with the Zotero connector — or ask below and I'll help you find papers to get started.";
    }
    return "I couldn't pick out clear themes from your library yet. Open a paper or pick a collection, or just ask me anything below.";
}

const FirstRunPage: React.FC<FirstRunPageProps> = ({ inputRef }) => {
    const suggestions = useAtomValue(firstRunSuggestionsAtom);
    const isLoading = useAtomValue(firstRunSuggestionsLoadingAtom);
    const error = useAtomValue(firstRunSuggestionsErrorAtom);
    const remainingCredits = useAtomValue(remainingBeaverCreditsAtom);
    const load = useSetAtom(loadFirstRunSuggestionsAtom);
    const refresh = useSetAtom(refreshFirstRunSuggestionsAtom);

    useEffect(() => {
        void load();
    }, [load]);

    const cards = suggestions?.cards ?? [];
    const librarySize = suggestions?.facts.library_size ?? 0;
    const showSkeletons = isLoading && cards.length === 0;
    const introLine = getIntroLine({
        isLoading: showSkeletons,
        cardCount: cards.length,
        librarySize,
        hasError: !!error && cards.length === 0,
    });

    return (
        <div
            id="first-run-page"
            className="display-flex flex-col flex-1 min-h-0"
        >
            <div className="display-flex flex-col flex-1 overflow-y-auto scrollbar px-3 pt-4 gap-4">
                <div className="flex-1" style={{ minHeight: '2vh', maxHeight: '4vh' }} />

                {/* Header */}
                <div className="display-flex flex-row items-start justify-between gap-3">
                    <div className="display-flex flex-row items-center gap-3">
                        <img
                            src="chrome://beaver/content/icons/beaver.png"
                            style={{ width: '2.75rem', height: '2.75rem' }}
                            alt=""
                        />
                        <div className="display-flex flex-col gap-05">
                            <div className="text-2xl font-semibold">Welcome</div>
                            {remainingCredits > 0 && (
                                <div className="text-sm font-color-secondary">
                                    {remainingCredits} credits to start
                                </div>
                            )}
                        </div>
                    </div>
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
                <div className="text-sm font-color-secondary px-1">{introLine}</div>

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

                {/* Fallback input — hidden during initial load */}
                {!showSkeletons && (
                    <div className="mt-2">
                        <DragDropWrapper>
                            <InputArea
                                inputRef={inputRef}
                                verticalPosition="below"
                                placeholder="Or ask me anything"
                                hideModelSelector
                                hideAttachmentMenu
                            />
                        </DragDropWrapper>
                    </div>
                )}

                <div className="flex-1" />
            </div>
        </div>
    );
};

export default FirstRunPage;
