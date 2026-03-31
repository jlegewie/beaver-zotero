import React from 'react';
import { CancelIcon } from '../../icons/icons';
import IconButton from '../IconButton';
import Button from '../Button';
import { eventManager } from '../../../events/eventManager';

interface ReaderTipContentProps {
    onDismiss: () => void;
}

const ReaderTipContent: React.FC<ReaderTipContentProps> = ({ onDismiss }) => {
    const handleOpenBeaver = () => {
        eventManager.dispatch('toggleChat', { forceOpen: true });
        onDismiss();
    };

    return (
        <div className="display-flex flex-col gap-3 w-full">
            {/* Header: logo + name + dismiss */}
            <div className="display-flex flex-row items-center justify-between w-full">
                <div className="display-flex flex-row gap-2 items-center">
                    <img
                        src="chrome://beaver/content/icons/beaver.png"
                        style={{ width: '1.25rem', height: '1.25rem' }}
                        alt="Beaver"
                    />
                    <span className="font-color-primary text-base font-medium">
                        Beaver
                    </span>
                </div>
                <IconButton
                    icon={CancelIcon}
                    variant="ghost-secondary"
                    onClick={onDismiss}
                />
            </div>

            {/* Primary text */}
            <div className="font-color-secondary text-base">
                Ask questions about this paper, explain equations, or compare claims with your library.
            </div>

            {/* Secondary text */}
            <div className="font-color-tertiary text-sm">
                Select any text to get instant explanations.
            </div>

            {/* CTA button */}
            <Button
                variant="solid"
                onClick={handleOpenBeaver}
                className="w-full"
            >
                Open Beaver &rarr;
            </Button>
        </div>
    );
};

export default ReaderTipContent;
