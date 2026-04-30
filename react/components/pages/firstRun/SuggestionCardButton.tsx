import React from 'react';
import { useSetAtom } from 'jotai';
import { CardKind, SuggestionCard } from '../../../types/librarySuggestions';
import { submitFirstRunCardAtom } from '../../../atoms/firstRun';
import BookmarkIcon from '../../icons/BookmarkIcon';
import BrainIcon from '../../icons/BrainIcon';
import GlobalSearchIcon from '../../icons/GlobalSearchIcon';
import FolderDetailIcon from '../../icons/FolderDetailIcon';
import TagIcon from '../../icons/TagIcon';

interface SuggestionCardButtonProps {
    card: SuggestionCard;
}

const ICON_BY_KIND: Record<CardKind, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
    reading_assistant: BrainIcon,
    literature_review: BookmarkIcon,
    discover_research: GlobalSearchIcon,
    organize_library: FolderDetailIcon,
    organize_tags: TagIcon,
};

const SuggestionCardButton: React.FC<SuggestionCardButtonProps> = ({ card }) => {
    const submit = useSetAtom(submitFirstRunCardAtom);
    const Icon = ICON_BY_KIND[card.kind] ?? BookmarkIcon;

    const handleClick = () => {
        void submit(card);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
        }
    };

    const baseClass = 'p-3 rounded-md cursor-pointer first-run-card';
    const emphasisClass = 'bg-quinary border-popup';

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            className={`${baseClass} ${emphasisClass}`}
        >
            <style>
                {`
                .first-run-card {
                    transition: background-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
                }
                .first-run-card:hover {
                    background-color: var(--fill-quinary);
                    transform: translateY(-1px);
                    box-shadow: 0 2px 6px rgba(0,0,0,0.08);
                }
                .first-run-card:active {
                    transform: translateY(0);
                    box-shadow: none;
                }
                .first-run-card:focus-visible {
                    outline: 2px solid var(--accent-blue);
                    outline-offset: 2px;
                }
                `}
            </style>
            <div className="display-flex flex-col gap-2">
                <div className="display-flex flex-row items-center gap-2">
                    <Icon width={17} height={17} className="font-color-primary" />
                    <div className="font-medium" style={{ fontSize: '1.075rem' }}>{card.title}</div>
                </div>
                <div className="text-base font-color-secondary">
                    {card.description_segments && card.description_segments.length > 0
                        ? card.description_segments.map((seg, i) =>
                            seg.emphasized
                                ? <span key={i} className="font-medium font-color-primary">{seg.text}</span>
                                : <span key={i}>{seg.text}</span>
                        )
                        : card.description}
                </div>
            </div>
        </div>
    );
};

export default SuggestionCardButton;
