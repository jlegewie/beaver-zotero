import React from 'react';
import Button from './Button';
import { Icon, Spinner, BrainIcon } from '../icons/icons';
import { MessageStatus } from '../../types/chat/uiTypes';

interface GeneratingIndicatorProps {
    status: MessageStatus;
}

const GeneratingIndicator: React.FC<GeneratingIndicatorProps> = ({ status }) => {
    const label = status === "thinking" ? "Thinking..." : "Generating...";
    
    return (
        // Matching style of AssistantMessageTools
        <div className="border-transparent rounded-md flex flex-col min-w-0">
            <Button
                variant="ghost-secondary"
                className={`
                    text-base scale-105 w-full min-w-0 align-start text-left
                    disabled-but-styled
                `}
                style={{ maxHeight: '5rem', padding: '4px 6px' }}
                disabled={true}
            >
                <div className="display-flex flex-row px-3 gap-2">
                    <div className="flex-1 display-flex mt-020">
                        <Icon icon={status === "thinking" ? BrainIcon : Spinner} />
                    </div>
                    
                    <div className="display-flex">
                        {label}
                    </div>
                    
                </div>
            </Button>
        </div>
    );
};

export default GeneratingIndicator;