import React, { useState, useCallback } from 'react';
import { ToolCall } from '../../types/chat/apiTypes';
import {
    GlobalSearchIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    Spinner,
    AlertIcon,
    Icon,
} from '../icons/icons';
import Button from '../ui/Button';
import { ToolDisplayFooter } from './ToolDisplayFooter';
import { useLoadingDots } from '../../hooks/useLoadingDots';
import ExternalReferenceListItem from '../externalReferences/ExternalReferenceListItem';

interface SearchExternalReferencesToolDisplayProps {
    toolCall: ToolCall;
}

const SearchExternalReferencesToolDisplay: React.FC<SearchExternalReferencesToolDisplayProps> = ({
    toolCall,
}) => {
    const [resultsVisible, setResultsVisible] = useState(false);
    const [isButtonHovered, setIsButtonHovered] = useState(false);
    const [hoveredItemIndex, setHoveredItemIndex] = useState<number | null>(null);
    const loadingDots = useLoadingDots(toolCall.status === 'in_progress');

    const references = toolCall?.result?.references ?? [];
    const totalCount = toolCall?.result?.returned_count ?? references.length;
    const hasReferences = totalCount > 0;
    
    const toggleResults = useCallback(() => {
        if (hasReferences) {
            setResultsVisible(!resultsVisible);
        }
    }, [hasReferences, resultsVisible]);

    const getIcon = () => {
        if (toolCall.status === 'in_progress') return Spinner;
        if (toolCall.status === 'error') return AlertIcon;
        if (totalCount === 0) return GlobalSearchIcon;

        if (isButtonHovered && !resultsVisible) return ArrowRightIcon;
        if (isButtonHovered && resultsVisible) return ArrowDownIcon;
        return GlobalSearchIcon;
    };
    
    const getButtonText = () => {
        if (toolCall.status === 'in_progress') return `Web Search${''.padEnd(loadingDots, '.')}`;
        
        if (totalCount === 0) return 'Web Search: No results';
        if (toolCall.label) return toolCall.label;
        // if (toolCall.result?.params?.topic_query) return toolCall.result.params.topic_query;
        return "Web Search";
    };

    const canToggleResults = hasReferences;
    const isButtonDisabled = !hasReferences;

    return (
        <div
            id={`tool-${toolCall.id}`}
            className={`
                rounded-md flex flex-col min-w-0
                ${resultsVisible ? 'border-popup' : 'border-transparent'}
            `}
        >
            <div
                className={`
                    display-flex flex-row  py-15
                    ${hasReferences && resultsVisible ? 'border-bottom-quinary' : ''}
                    ${resultsVisible ? 'bg-senary' : ''}
                `}
                onMouseEnter={() => setIsButtonHovered(true)}
                onMouseLeave={() => setIsButtonHovered(false)}
            >
                 <div className="display-flex flex-row flex-1" onClick={toggleResults}>
                    <Button
                        variant="ghost-secondary"
                        // icon={getIcon()}
                        className={`
                            text-base scale-105 min-w-0 align-start text-left
                            ${isButtonDisabled && !canToggleResults ? 'disabled-but-styled' : ''}
                        `}
                        style={{ padding: '2px 6px', maxHeight: 'none'}}
                        disabled={isButtonDisabled && !canToggleResults}
                    >
                        <div className="display-flex flex-row px-3 gap-2">
                            <div className={`flex-1 display-flex mt-020 ${resultsVisible ? 'font-color-primary' : ''}`}>
                                <Icon icon={getIcon()} />
                            </div>
                            
                            <div>
                                {getButtonText()}
                                {/* <span className={`font-semibold ${resultsVisible ? 'font-color-primary' : ''}`}>
                                    Web Search
                                    <span className="font-color-tertiary ml-2 font-medium">
                                        {'"' + (toolCall?.result?.params?.topic_query ?? '') + '"'}
                                    </span>
                                </span> */}
                            </div>
                            
                        </div>
                        {/* {getButtonText()}
                        {hasReferences &&
                            <span className="ml-05 mt-015 font-color-tertiary text-xs">{totalCount}x</span>
                        } */}
                    </Button>
                    <div className="flex-1"/>
                </div>
            </div>

            {hasReferences && resultsVisible && (
                <div className="display-flex flex-col">
                    {references.map((item, index) => (
                        <ExternalReferenceListItem
                            key={index}
                            item={item}
                            isHovered={hoveredItemIndex === index}
                            onMouseEnter={() => setHoveredItemIndex(index)}
                            onMouseLeave={() => setHoveredItemIndex(null)}
                            className={index === 0 ? 'pt-2' : ''}
                        />
                    ))}
                    <ToolDisplayFooter toggleContent={toggleResults} />
                </div>
            )}
        </div>
    );
};

export default SearchExternalReferencesToolDisplay;
