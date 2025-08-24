import React, { useEffect, useState } from 'react';
import Button from './Button';
import { Icon, Spinner, BrainIcon } from '../icons/icons';
import { MessageStatus } from '../../types/chat/uiTypes';

interface GeneratingIndicatorProps {
    status: MessageStatus;
    previousMessageHasToolCalls: boolean;
}

const GeneratingIndicator: React.FC<GeneratingIndicatorProps> = ({ status, previousMessageHasToolCalls }) => {
    const [loadingDots, setLoadingDots] = useState(1);

    useEffect(() => {
        setLoadingDots(1); 
        const interval = setInterval(() => {
            setLoadingDots((dots) => (dots < 3 ? dots + 1 : 1));
        }, 250);
        return () => {
            if (interval) clearInterval(interval);
        };
    }, []);
    
    return (
        // Matching style of AssistantMessageTools
        <div className={`
            border-transparent rounded-md flex flex-col min-w-0 display-flex flex-col py-1 mb-2
            ${previousMessageHasToolCalls ? '-mt-2' : ''}
        `}>
            <Button
                variant="ghost-secondary"
                className={`
                    text-base scale-105 w-full min-w-0 align-start text-left
                    disabled-but-styled
                `}
                style={{ maxHeight: '5rem', padding: '2px 6px' }}
                disabled={true}
            >
                <div className="display-flex flex-row px-3 gap-2">
                    <div className="flex-1 display-flex mt-020">
                        <Icon icon={status === "thinking" ? BrainIcon : Spinner} />
                    </div>
                    
                    <div className="display-flex">
                        {'Generating' + '.'.repeat(loadingDots)}
                    </div>
                    
                </div>
            </Button>
        </div>
    );
};

export default GeneratingIndicator;