import React, { useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import MarkdownRenderer from './MarkdownRenderer';
import { Spinner, Icon, BrainIcon, ArrowRightIcon, ArrowDownIcon } from '../icons/icons';
import Button from '../ui/Button';
import { useLoadingDots } from '../../hooks/useLoadingDots';
import { thinkingVisibilityAtom, toggleThinkingVisibilityAtom } from '../../atoms/messageUIState';

interface ThinkingContentProps {
    messageId: string;
    thinkingContent: string;
    isThinking: boolean;
    previousMessageHasToolCalls: boolean;
    messageHasContent: boolean;
}

const ThinkingContent: React.FC<ThinkingContentProps> = ({ messageId, thinkingContent, isThinking, previousMessageHasToolCalls, messageHasContent }) => {
    const thinkingVisibilityMap = useAtomValue(thinkingVisibilityAtom);
    const toggleVisibility = useSetAtom(toggleThinkingVisibilityAtom);
    const resultsVisible = thinkingVisibilityMap[messageId] ?? false;
    const loadingDots = useLoadingDots(isThinking);
    const [isButtonHovered, setIsButtonHovered] = useState(false);

    const toggleResults = () => {
        toggleVisibility(messageId);
    };

    const getIcon = () => {
        if (resultsVisible) return ArrowDownIcon;
        if (isButtonHovered) return ArrowRightIcon;
        if (isThinking) return Spinner;
        return BrainIcon;
    };
    
    return (
        <div className={`
            ${resultsVisible ? 'border-popup' : 'border-transparent'} 
            rounded-md flex flex-col min-w-0 display-flex flex-col py-1 ${messageHasContent ? 'mb-2' : 'mb-15'}
            ${previousMessageHasToolCalls ? '-mt-2' : ''}
        `}>
            <Button
                variant="ghost-secondary"
                onClick={toggleResults}
                onMouseEnter={() => setIsButtonHovered(true)}
                onMouseLeave={() => setIsButtonHovered(false)}
                className="text-base scale-105 w-full min-w-0 align-start text-left"
                // ${isThinking ? 'justify-start' : ''}
                style={{ padding: '2px 6px', maxHeight: 'none'}}
                // disabled={isButtonDisabled && !canToggleResults}
            >
                <div className="display-flex flex-row px-3 gap-2">
                    <div className={`flex-1 display-flex mt-020 ${resultsVisible ? 'font-color-primary' : ''}`}>
                        <Icon icon={getIcon()} />
                    </div>
                    
                    <div className={`display-flex ${resultsVisible ? 'font-color-primary' : ''}`}>
                        {'Thinking' + '.'.repeat(isThinking ? loadingDots : 0)}
                    </div>
                    
                </div>
            </Button>

            {resultsVisible && (
                <div
                    className={`py-1 ${resultsVisible ? 'border-top-quinary' : ''} mt-15 opacity-70 p-3 text-sm`}
                >
                    <MarkdownRenderer
                        className="markdown"
                        content={thinkingContent.replace(/^undefined/, '')}
                        enableNoteBlocks={false}
                    />
                </div>
            )}
        </div>
    );
};

export default ThinkingContent;