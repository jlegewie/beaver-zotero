import React, { useState, useCallback } from 'react';
import { SearchExternalReferencesResult, ExternalReferenceResult } from '../../types/chat/apiTypes';
import {
    Icon,
    GlobalSearchIcon,
    ArrowDownIcon,
    ArrowUpIcon,
    ArrowRightIcon,
} from '../icons/icons';
import Button from '../ui/Button';

interface SearchExternalReferencesToolDisplayProps {
    result: SearchExternalReferencesResult;
    isHovered: boolean;
}

const formatAuthors = (authors?: string[]): string => {
    if (!authors || authors.length === 0) return '';

    const clean = authors.filter(Boolean).map(a => a.trim());

    if (clean.length === 0) return '';

    if (clean.length > 3) {
        return `${clean[0]} et al.`;
    }

    if (clean.length === 1) {
        return clean[0];
    }

    if (clean.length === 2) {
        return `${clean[0]} and ${clean[1]}`;
    }

    // exactly 3
    return `${clean[0]}, ${clean[1]} and ${clean[2]}`;
}

interface ExternalReferenceItemProps {
    item: ExternalReferenceResult;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    className?: string;
}

const ExternalReferenceItem: React.FC<ExternalReferenceItemProps> = ({
    item,
    isHovered,
    onMouseEnter,
    onMouseLeave,
    className,
}) => {
    const authors = formatAuthors(item.authors);
    const metaParts = [item.publication_title || item.venue, item.year].filter(Boolean);
    const meta = metaParts.join(', ');

    const baseClasses = [
        'px-3',
        'py-15',
        'display-flex',
        'flex-col',
        'gap-1',
        'cursor-pointer',
        'rounded-sm',
        'transition',
        'user-select-none',
    ];

    if (isHovered) {
        baseClasses.push('bg-quinary');
    }

    const handleClick = useCallback(() => {
        // Future: Navigate to item or show details
    }, []);

    return (
        <div
            className={`${baseClasses.join(' ')} ${className}`}
            onClick={handleClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className="display-flex flex-row items-start gap-3">
                <div className="display-flex flex-col flex-1 gap-1 min-w-0 font-color-primary">
                    <div>{item.title || 'Untitled Item'}</div>
                    {authors && 
                        <div className="display-flex flex-row items-center gap-1">
                            <div className="font-color-secondary truncate">{authors}</div>
                        </div>
                    }
                    {meta && <div className="font-color-secondary">{meta}</div>}
                </div>
            </div>
        </div>
    );
};

const SearchExternalReferencesToolDisplay: React.FC<SearchExternalReferencesToolDisplayProps> = ({
    result,
    isHovered,
}) => {
    const [resultsVisible, setResultsVisible] = useState(false);
    const [isButtonHovered, setIsButtonHovered] = useState(false);
    const [isExpandHovered, setIsExpandHovered] = useState(false);
    const [hoveredItemIndex, setHoveredItemIndex] = useState<number | null>(null);

    const references = result.references || [];
    const totalCount = result.total_available || references.length;
    const hasReferences = references.length > 0;
    
    const toggleResults = useCallback(() => {
        if (hasReferences) {
            setResultsVisible(!resultsVisible);
        }
    }, [hasReferences, resultsVisible]);

    const getIcon = () => {
        if (totalCount === 0) return GlobalSearchIcon;

        if (isButtonHovered && !resultsVisible) return ArrowRightIcon;
        if (isButtonHovered && resultsVisible) return ArrowDownIcon;
        return GlobalSearchIcon;
    };
    
    const getButtonText = () => {
        if (totalCount === 0) return 'Paper Finder: No results';
        return 'Paper Finder';
    };

    const canToggleResults = hasReferences;
    const isButtonDisabled = !hasReferences;

    return (
        <div className="border-popup rounded-md display-flex flex-col min-w-0">
             <div
                className={`display-flex flex-row bg-senary py-15 px-2 ${hasReferences ? 'border-bottom-quinary' : ''}`}
                onMouseEnter={() => setIsButtonHovered(true)}
                onMouseLeave={() => setIsButtonHovered(false)}
            >
                 <div className="display-flex flex-row flex-1" onClick={toggleResults}>
                    <Button
                        variant="ghost-secondary"
                        icon={getIcon()}
                        className={`
                            text-base scale-105
                            ${isButtonDisabled && !canToggleResults ? 'disabled-but-styled' : ''}
                        `}
                        disabled={isButtonDisabled && !canToggleResults}
                    >
                        {getButtonText()}
                        {hasReferences &&
                            <span className="ml-05 mt-015 font-color-tertiary text-xs">{totalCount}x</span>
                        }
                    </Button>
                    <div className="flex-1"/>
                </div>
                <div className="text-sm truncate font-color-tertiary mt-015" style={{ maxWidth: '125px' }}>
                </div>
            </div>

            {hasReferences && (
                <div className="display-flex flex-col">
                    {(resultsVisible ? references : references.slice(0, 3)).map((item, index) => (
                        <ExternalReferenceItem
                            key={index}
                            item={item}
                            isHovered={hoveredItemIndex === index}
                            onMouseEnter={() => setHoveredItemIndex(index)}
                            onMouseLeave={() => setHoveredItemIndex(null)}
                            className={index === 0 ? 'pt-2' : ''}
                        />
                    ))}
                    {references.length > 3 && (
                        <div 
                            className={`display-flex flex-row justify-center items-center cursor-pointer -mt-1 ${isExpandHovered ? 'bg-senary' : ''}`}
                            onClick={toggleResults}
                            onMouseEnter={() => setIsExpandHovered(true)}
                            onMouseLeave={() => setIsExpandHovered(false)}
                        >
                            <Icon
                                icon={resultsVisible ? ArrowUpIcon : ArrowDownIcon}
                                className={`scale-75 ${isExpandHovered ? 'font-color-primary' : 'font-color-secondary'}`}
                            />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default SearchExternalReferencesToolDisplay;
