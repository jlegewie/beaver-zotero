import React from 'react';
import { Icon, CancelIcon, PdfIcon, SearchIcon, FolderAddIcon, GlobalSearchIcon } from '../../icons/icons';
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
        icon: GlobalSearchIcon,
        title: 'Discover new research',
        description: 'Search 240M scholarly works',
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

            {/* Header: logo + title + subtitle + dismiss */}
            <div className="display-flex flex-row gap-1 items-start">
                <img
                    src="chrome://beaver/content/icons/beaver.png"
                    style={{ width: '2.5rem', height: '2.5rem' }}
                    alt="Beaver"
                />
                <div className="display-flex flex-col gap-1">
                    <div className="font-color-primary text-xl font-semibold mt-15">
                        Welcome to Beaver
                    </div>
                    <div className="font-color-tertiary text-base">
                        Your AI research assistant for Zotero
                    </div>
                </div>
                <div className="flex-1"/>
                <IconButton
                    icon={CancelIcon}
                    variant="ghost-secondary"
                    onClick={onDismiss}
                />
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
            <div className="display-flex flex-col gap-3 items-center">
                <Button
                    variant="solid"
                    onClick={handleOpenBeaver}
                    className="items-center"
                    style={{ padding: '5px 6px', width: '100%', alignItems: 'center', justifyContent: 'center', fontSize: "0.95rem" }}
                >
                    Open Beaver &rarr;
                </Button>

                {/* Try it later */}
                <Button
                    variant="ghost-secondary"
                    onClick={onDismiss}
                    // className="self-center"
                >
                    Try it later
                </Button>
            </div>

            {/* Keyboard shortcut tip */}
            <div
                className="font-color-tertiary text-sm text-center"
                style={{
                    borderTop: '1px solid var(--fill-quinary)',
                    paddingTop: '8px',
                }}
            >
                Tip: Open Beaver using the button{' '}
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    width="1.2em"
                    height="1.2em"
                    fill="none"
                    style={{ verticalAlign: 'middle', background: 'var(--fill-quinary)', borderRadius: '4px', padding: '2px' }}
                >
                    <path d="M16.6917 9.80279L18.4834 8.01108C19.1722 7.32225 19.1722 6.20545 18.4834 5.51662C17.7946 4.82779 16.6777 4.82779 15.9889 5.51662L14.1972 7.30833M16.6917 9.80279L6.01108 20.4834C5.32225 21.1722 4.20545 21.1722 3.51662 20.4834C2.82779 19.7946 2.82779 18.6777 3.51662 17.9889L14.1972 7.30833M16.6917 9.80279L14.1972 7.30833" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
                    <path d="M17.9737 14.0215C17.9795 13.9928 18.0205 13.9928 18.0263 14.0215C18.3302 15.5081 19.4919 16.6698 20.9785 16.9737C21.0072 16.9795 21.0072 17.0205 20.9785 17.0263C19.4919 17.3302 18.3302 18.4919 18.0263 19.9785C18.0205 20.0072 17.9795 20.0072 17.9737 19.9785C17.6698 18.4919 16.5081 17.3302 15.0215 17.0263C14.9928 17.0205 14.9928 16.9795 15.0215 16.9737C16.5081 16.6698 17.6698 15.5081 17.9737 14.0215Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
                    <path d="M8.12063 3.30967C8.20503 2.89678 8.79497 2.89678 8.87937 3.30967C9.06576 4.22159 9.77841 4.93424 10.6903 5.12063C11.1032 5.20503 11.1032 5.79497 10.6903 5.87937C9.77841 6.06576 9.06576 6.77841 8.87937 7.69033C8.79497 8.10322 8.20503 8.10322 8.12063 7.69033C7.93424 6.77841 7.22159 6.06576 6.30967 5.87937C5.89678 5.79497 5.89678 5.20503 6.30967 5.12063C7.22159 4.93424 7.93424 4.22159 8.12063 3.30967Z" fill="currentColor" />
                </svg>
                {' '}or with{' '}
                <code
                    style={{
                        background: 'var(--fill-quinary)',
                        padding: '2px 5px',
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
