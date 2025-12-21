import React from 'react';
import { ModelMessage } from '../../agents/types';
import Button from '../ui/Button';
import {
    Icon,
    PuzzleIcon,
} from '../icons/icons';

interface ContextCompressionIndicatorProps {
    message: ModelMessage;
}

/**
 * Renders a context compression indicator.
 */
export const ContextCompressionIndicator: React.FC<ContextCompressionIndicatorProps> = ({ message }) => {
    const compressedCount = message.metadata?.context_compression?.compressed_count ?? 0;

    console.log('compressedCount', compressedCount);


    return (
        <div
            id={`context-compression-indicator`}
            className="rounded-md flex flex-col min-w-0"
        >
            <div
                className="display-flex flex-row py-15"
            >
                <Button
                    variant="ghost-secondary"
                    onClick={() => {}}
                    className="text-base scale-105 w-full min-w-0 align-start text-left"
                    style={{ padding: '2px 6px', maxHeight: 'none' }}
                >
                    <div className="display-flex flex-row px-3 gap-2">
                        <div className="flex-1 display-flex mt-010">
                            <Icon icon={PuzzleIcon} />
                        </div>
                        
                        <div className="display-flex">
                            {compressedCount} items compressed
                        </div>
                    </div>
                </Button>
            </div>
        </div>
    );
};

export default ContextCompressionIndicator;

