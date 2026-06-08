import React from 'react';
import { ChartIcon, ChattingIcon, CancelIcon, HighlighterIcon, Icon, TextAlignLeftIcon, LibraryIcon } from '../../icons/icons';
import IconButton from '../IconButton';
import Button from '../Button';
import { eventManager } from '../../../events/eventManager';

interface ReaderTipContentProps {
    onDismiss: () => void;
}

const features = [
    {
        icon: ChattingIcon,
        title: 'Ask about this paper',
        description: 'Answers grounded in the open PDF, with sentence-level citations.',
    },
    {
        icon: ChartIcon,
        title: 'Understand text, figures & tables',
        description: 'Select a passage, or attach a figure with an area annotation, for an instant explanation.',
    },
    {
        icon: HighlighterIcon,
        title: 'Annotate the PDF',
        description: 'Ask Beaver to highlight key findings or anything relevant to your work.',
    },
    {
        icon: LibraryIcon,
        title: 'Connect it to your library',
        description: 'Ask whether the rest of your library confirms, contradicts, or extends this paper\'s claims.',
    },
];

const ReaderTipContent: React.FC<ReaderTipContentProps> = ({ onDismiss }) => {
    const handleOpenBeaver = () => {
        eventManager.dispatch('toggleChat', { forceOpen: true });
        onDismiss();
    };

    const handleLearnMore = () => {
        Zotero.launchURL('https://www.beaverapp.ai/docs/zotero-reader');
    };

    return (
        <div className="display-flex flex-col gap-5 w-full">
            <div className="display-flex flex-col gap-05 w-full">
                <div className="display-flex flex-row items-center justify-between w-full">
                    <span className="text-base font-semibold font-color-secondary">
                        Beaver
                    </span>
                    <IconButton
                        icon={CancelIcon}
                        variant="ghost-secondary"
                        onClick={onDismiss}
                    />
                </div>

                <div className="font-color-primary text-xl font-semibold">
                    Reading assistant
                </div>
            </div>

            <div className="display-flex flex-col gap-4">
                {features.map((feature) => (
                    <div key={feature.title} className="display-flex flex-row gap-3 items-start">
                        <div className="flex-shrink-0">
                            <Icon icon={feature.icon} className="scale-11 mt-020 font-color-primary" />
                        </div>
                        <div className="display-flex flex-col gap-05">
                            <span className="font-color-primary text-base font-medium">
                                {feature.title}
                            </span>
                            <span className="font-color-secondary text-sm">
                                {feature.description}
                            </span>
                        </div>
                    </div>
                ))}
            </div>

            <div
                className="display-flex flex-row items-center justify-between gap-2 pt-3"
                style={{ borderTop: '1px solid var(--fill-quinary)' }}
            >
                <Button
                    variant="ghost-secondary"
                    onClick={handleLearnMore}
                >
                    Learn more
                </Button>
                <Button
                    variant="solid"
                    onClick={handleOpenBeaver}
                    className="items-center"
                    style={{ padding: '4px 10px', alignItems: 'center', justifyContent: 'center', fontSize: '0.95rem' }}
                >
                    Open Beaver
                </Button>
            </div>
        </div>
    );
};

export default ReaderTipContent;
