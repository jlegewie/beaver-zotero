import React, { useState, useCallback } from 'react';
import { ToolCall } from '../../types/chat/apiTypes';
import {
    GlobalSearchIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    Spinner,
    AlertIcon,
} from '../icons/icons';
import Button from '../ui/Button';
import { ToolDisplayFooter } from './ToolDisplayFooter';
import { useLoadingDots } from '../../hooks/useLoadingDots';
import ExternalReferenceListItem from '../externalReferences/ExternalReferenceListItem';

interface CreateItemToolDisplayProps {
    toolCall: ToolCall;
}

const CreateItemToolDisplay: React.FC<CreateItemToolDisplayProps> = ({
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
        return 'Web Search';
    };

    const canToggleResults = hasReferences;
    const isButtonDisabled = !hasReferences;

    return (
        <div className="border-popup rounded-md display-flex flex-col min-w-0">
            <div
                className={`
                    display-flex flex-row bg-senary py-15 px-2
                    ${hasReferences && resultsVisible ? 'border-bottom-quinary' : ''}
                `}
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

export default CreateItemToolDisplay;
