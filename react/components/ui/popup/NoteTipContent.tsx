import React from 'react';
import { CancelIcon } from '../../icons/icons';
import IconButton from '../IconButton';
import Button from '../Button';
import { eventManager } from '../../../events/eventManager';

interface NoteTipContentProps {
    onDismiss: () => void;
}

const NoteTipContent: React.FC<NoteTipContentProps> = ({ onDismiss }) => {
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
                        style={{ width: '2rem', height: '2rem' }}
                        alt="Beaver"
                    />
                    <span className="font-color-primary text-xl font-medium">
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
                Use Beaver as a writing assistant for your Zotero notes.
            </div>

            {/* Secondary text */}
            <div className="font-color-tertiary text-base">
                Summarize papers, draft sections, and find citations while you write.
            </div>

            {/* CTA button */}
            <Button
                variant="solid"
                onClick={handleOpenBeaver}
                className="items-center"
                style={{ padding: '4px 6px', width: '100%', alignItems: 'center', justifyContent: 'center', fontSize: "0.95rem" }}
            >
                Open Beaver &rarr;
            </Button>
        </div>
    );
};

export default NoteTipContent;
