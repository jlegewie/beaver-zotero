import React from 'react';
import { Icon, CancelIcon, PdfIcon, SearchIcon, FolderAddIcon } from '../../icons/icons';
import IconButton from '../IconButton';
import Button from '../Button';
import { eventManager } from '../../../events/eventManager';
import { getPref } from '../../../../src/utils/prefs';

interface WelcomeOnboardingContentProps {
    onDismiss: () => void;
}

const features = [
    {
        icon: PdfIcon,
        title: 'Ask questions about any PDF',
        description: 'Get answers with page-level citations',
    },
    {
        icon: SearchIcon,
        title: 'Search your library by meaning',
        description: 'Find papers by topic, not just keywords',
    },
    {
        icon: FolderAddIcon,
        title: 'Organize automatically',
        description: 'Auto-tag, sort, and manage collections',
    },
];

const WelcomeOnboardingContent: React.FC<WelcomeOnboardingContentProps> = ({ onDismiss }) => {
    const handleOpenBeaver = () => {
        eventManager.dispatch('toggleChat', { forceOpen: true });
        onDismiss();
    };

    const keyboardShortcut = (getPref('keyboardShortcut') || 'j').toUpperCase();
    const shortcutDisplay = Zotero.isMac ? `\u2318${keyboardShortcut}` : `Ctrl+${keyboardShortcut}`;

    return (
        <div className="display-flex flex-col gap-4 w-full">
            {/* Header: logo + dismiss */}
            <div className="display-flex flex-row items-center justify-between w-full">
                <img
                    src="chrome://beaver/content/icons/beaver.png"
                    style={{ width: '1.5rem', height: '1.5rem' }}
                    alt="Beaver"
                />
                <IconButton
                    icon={CancelIcon}
                    variant="ghost-secondary"
                    onClick={onDismiss}
                />
            </div>

            {/* Title + subtitle */}
            <div className="display-flex flex-col gap-1">
                <div className="font-color-primary text-xl font-semibold">
                    Welcome to Beaver
                </div>
                <div className="font-color-tertiary text-base">
                    Your AI research assistant for Zotero
                </div>
            </div>

            {/* Feature rows */}
            <div className="display-flex flex-col gap-2">
                {features.map((feature, index) => (
                    <div
                        key={index}
                        className="display-flex flex-row gap-3 items-center p-2"
                        style={{
                            background: 'var(--fill-senary)',
                            borderRadius: '6px',
                        }}
                    >
                        <div className="flex-shrink-0">
                            <Icon icon={feature.icon} className="scale-12 font-color-secondary" />
                        </div>
                        <div className="display-flex flex-col gap-0">
                            <span className="font-color-primary text-base font-medium">
                                {feature.title}
                            </span>
                            <span className="font-color-tertiary text-sm">
                                {feature.description}
                            </span>
                        </div>
                    </div>
                ))}
            </div>

            {/* CTA button */}
            <Button
                variant="solid"
                onClick={handleOpenBeaver}
                className="w-full"
            >
                Open Beaver &rarr;
            </Button>

            {/* Try it later */}
            <div
                className="font-color-tertiary text-sm text-center cursor-pointer"
                onClick={onDismiss}
                style={{ marginTop: '-4px' }}
            >
                Try it later
            </div>

            {/* Keyboard shortcut tip */}
            <div
                className="font-color-tertiary text-sm text-center"
                style={{
                    borderTop: '1px solid var(--fill-quinary)',
                    paddingTop: '8px',
                }}
            >
                Tip: Open Beaver anytime from the sidebar icon or press{' '}
                <code
                    style={{
                        background: 'var(--fill-quinary)',
                        padding: '1px 5px',
                        borderRadius: '3px',
                        fontSize: '0.85em',
                    }}
                >
                    {shortcutDisplay}
                </code>
            </div>
        </div>
    );
};

export default WelcomeOnboardingContent;
