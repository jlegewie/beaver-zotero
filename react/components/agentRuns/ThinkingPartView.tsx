import React, { useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ThinkingPart } from '../../agents/types';
import MarkdownRenderer from '../messages/MarkdownRenderer';
import Button from '../ui/Button';
import { Spinner, Icon, BrainIcon, ArrowRightIcon, ArrowDownIcon } from '../icons/icons';
import { thinkingVisibilityAtom, toggleThinkingVisibilityAtom } from '../../atoms/messageUIState';

interface ThinkingPartViewProps {
    parts: ThinkingPart[];
    isThinking: boolean;
    hasFollowingContent: boolean;
    /** Unique ID for persistent visibility state */
    thinkingId: string;
}

/**
 * Renders a collapsible thinking/reasoning section.
 * Shows a button that can be expanded to reveal the thinking content.
 */
export const ThinkingPartView: React.FC<ThinkingPartViewProps> = ({
    parts,
    isThinking,
    hasFollowingContent,
    thinkingId,
}) => {
    // Use Jotai atom for persistent visibility state (matches ThinkingContent behavior)
    const thinkingVisibilityMap = useAtomValue(thinkingVisibilityAtom);
    const toggleVisibility = useSetAtom(toggleThinkingVisibilityAtom);
    const isExpanded = thinkingVisibilityMap[thinkingId] ?? false;
    const [isHovered, setIsHovered] = useState(false);

    const toggleExpanded = () => {
        toggleVisibility(thinkingId);
    };

    const getIcon = () => {
        if (isExpanded) return ArrowDownIcon;
        if (isHovered) return ArrowRightIcon;
        if (isThinking) return Spinner;
        return BrainIcon;
    };

    const content = parts.map(part => part.content).join('\n\n');

    if (!content || content.trim() === '') {
        return null;
    }

    return (
        <div
            className={`
                rounded-md flex flex-col min-w-0
                ${isExpanded ? 'border-popup' : 'border-transparent'}
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
                        content={content.replace(/^undefined/, '')}
                        enableNoteBlocks={false}
                    />
                </div>
            )}
        </div>
    );
};

export default ThinkingPartView;

