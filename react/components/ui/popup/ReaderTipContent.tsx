import React, { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { ChartIcon, ChattingIcon, CancelIcon, HighlighterIcon, Icon, LibraryIcon } from '../../icons/icons';
import IconButton from '../IconButton';
import Button from '../Button';
import { eventManager } from '../../../events/eventManager';
import { stageActionPillAtom } from '../../../atoms/actions';
import { useActionRunner } from '../../../hooks/useActionRunner';

interface ReaderTipContentProps {
    onDismiss: () => void;
}

interface ReaderTipFeature {
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    title: string;
    description: string;
    /** Built-in action to stage in the chat input when the user clicks Try it. */
    actionId?: string;
}

const features: ReaderTipFeature[] = [
    {
        icon: ChattingIcon,
        title: 'Ask about this paper',
        description: 'Answers grounded in the open PDF, with sentence-level citations.',
    },
    {
        icon: ChartIcon,
        title: 'Understand text, figures & tables',
        description: 'Select a passage in the PDF and choose Explain, or attach a figure with an area annotation, for an instant explanation.',
    },
    {
        icon: HighlighterIcon,
        title: 'Annotate the PDF',
        description: 'Ask Beaver to highlight key findings or anything relevant to your work.',
        actionId: 'builtin-color-code',
    },
    {
        icon: LibraryIcon,
        title: 'Connect it to your library',
        description: 'Ask whether the rest of your library confirms, contradicts, or extends this paper.',
        actionId: 'builtin-fit-research',
    },
];

const ReaderTipContent: React.FC<ReaderTipContentProps> = ({ onDismiss }) => {
    const { isBusy } = useActionRunner();
    const stageActionPill = useSetAtom(stageActionPillAtom);

    const handleOpenBeaver = () => {
        eventManager.dispatch('toggleChat', { forceOpen: true });
        onDismiss();
    };

    const handleLearnMore = () => {
        Zotero.launchURL('https://www.beaverapp.ai/docs/zotero-reader');
    };

    const handleTryAction = useCallback((actionId: string) => {
        if (isBusy) return;
        eventManager.dispatch('toggleChat', { forceOpen: true });
        stageActionPill({
            actionId,
            targetType: 'attachment',
            targetWindow: Zotero.getMainWindow(),
        });
        onDismiss();
    }, [isBusy, onDismiss, stageActionPill]);

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
                                {feature.actionId && (
                                    <>
                                        {' '}
                                        <button
                                            type="button"
                                            className={`text-link text-sm p-0 border-0 bg-transparent inline ${isBusy ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                                            style={{ opacity: isBusy ? 0.5 : 1 }}
                                            onClick={() => handleTryAction(feature.actionId!)}
                                            disabled={isBusy}
                                        >
                                            Try it &rarr;
                                        </button>
                                    </>
                                )}
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
