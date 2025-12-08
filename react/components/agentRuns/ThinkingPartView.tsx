import React, { useState } from 'react';
import { ThinkingPart } from '../../agents/types';
import MarkdownRenderer from '../messages/MarkdownRenderer';
import Button from '../ui/Button';
import { Spinner, Icon, BrainIcon, ArrowRightIcon, ArrowDownIcon } from '../icons/icons';

interface ThinkingPartViewProps {
    part: ThinkingPart;
    isThinking: boolean;
    hasFollowingContent: boolean;
}

/**
 * Renders a collapsible thinking/reasoning section.
 * Shows a button that can be expanded to reveal the thinking content.
 */
export const ThinkingPartView: React.FC<ThinkingPartViewProps> = ({
    part,
    isThinking,
    hasFollowingContent,
}) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isHovered, setIsHovered] = useState(false);

    const toggleExpanded = () => {
        setIsExpanded(!isExpanded);
    };

    const getIcon = () => {
        if (isExpanded) return ArrowDownIcon;
        if (isHovered) return ArrowRightIcon;
        if (isThinking) return Spinner;
        return BrainIcon;
    };

    if (!part.content || part.content.trim() === '') {
        return null;
    }

    return (
        <div
            className={`
                rounded-md flex flex-col min-w-0
                ${isExpanded ? 'border-popup' : 'border-transparent'}
                ${hasFollowingContent ? 'mb-2' : 'mb-15'}
            `}
        >
            <div
                className={`
                    display-flex flex-row py-15
                    ${isExpanded ? 'border-bottom-quinary bg-senary' : ''}
                `}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <div className="display-flex flex-row flex-1" onClick={toggleExpanded}>
                    <Button
                        variant="ghost-secondary"
                        className="text-base scale-105 w-full min-w-0 align-start text-left"
                        style={{ padding: '2px 6px', maxHeight: 'none' }}
                    >
                        <div className="display-flex flex-row px-3 gap-2">
                            <div className={`flex-1 display-flex mt-010 ${isExpanded ? 'font-color-primary' : ''}`}>
                                <Icon icon={getIcon()} />
                            </div>
                            
                            <div className={`display-flex ${isExpanded ? 'font-color-primary' : ''} ${isThinking ? 'shimmer-text' : ''}`}>
                                Thinking
                            </div>
                        </div>
                    </Button>
                    <div className="flex-1"/>
                </div>
            </div>

            {isExpanded && (
                <div className="opacity-70 p-3 text-sm">
                    <MarkdownRenderer 
                        className="markdown" 
                        content={part.content.replace(/^undefined/, '')}
                        enableNoteBlocks={false}
                    />
                </div>
            )}
        </div>
    );
};

export default ThinkingPartView;

