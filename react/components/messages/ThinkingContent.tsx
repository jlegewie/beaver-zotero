import React, { useState, useEffect } from 'react';
import MarkdownRenderer from './MarkdownRenderer';
import { Spinner, Icon, BrainIcon, ArrowRightIcon, ArrowDownIcon } from '../icons/icons';
import Button from '../ui/Button';

interface ThinkingContentProps {
    thinkingContent: string;
    isThinking: boolean;
    previousMessageHasToolCalls: boolean;
}

const ThinkingContent: React.FC<ThinkingContentProps> = ({ thinkingContent, isThinking, previousMessageHasToolCalls }) => {
    const [resultsVisible, setResultsVisible] = useState(false);
    const [loadingDots, setLoadingDots] = useState(1);
    const [isButtonHovered, setIsButtonHovered] = useState(false);

    useEffect(() => {
        let interval: NodeJS.Timeout | undefined;
        if (isThinking) {
            setLoadingDots(1); 
            interval = setInterval(() => {
                setLoadingDots((dots) => (dots < 3 ? dots + 1 : 1));
            }, 250);
        } else {
            setLoadingDots(0); 
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [isThinking]);

    const toggleResults = () => {
        setResultsVisible(!resultsVisible);
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
            rounded-md flex flex-col min-w-0 display-flex flex-col py-1 mb-2
            ${previousMessageHasToolCalls ? '-mt-3' : ''}
        `}>
            <Button
                variant="ghost-secondary"
                onClick={toggleResults}
                onMouseEnter={() => setIsButtonHovered(true)}
                onMouseLeave={() => setIsButtonHovered(false)}
                className="text-base scale-105 w-full min-w-0 align-start text-left"
                // ${isThinking ? 'justify-start' : ''}
                style={{ padding: '4px 6px', maxHeight: 'none'}}
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
                    <MarkdownRenderer className="markdown" content={thinkingContent.replace(/^undefined/, '')} />
                </div>
            )}
        </div>
    );
};

export default ThinkingContent;