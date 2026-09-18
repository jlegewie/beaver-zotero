import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { chatAccessGateAtom } from '../../../atoms/chatAccess';
import { openQuickPromptAtom } from '../../../atoms/quickPrompt';
import { TickIcon, CancelIcon } from '../../icons/icons';
import Icon from '@beaver/agent-ui/icons/Icon';
import { PopupMessage, PopupMessageFeature } from '../../../types/popupMessage';
import Button from "@beaver/agent-ui/primitives/Button";
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { parseTextWithLinksAndNewlines } from '../../../utils/parseTextWithLinksAndNewlines';
import FeatureTourContent from './FeatureTourContent';
import { FeatureStep, VersionAlsoNew, VersionShortcutId } from '../../../constants/versionUpdateMessages';
import PictureInPictureIcon from '@beaver/agent-ui/icons/PictureInPictureIcon';
import { beaverWindowShortcutKeys, quickPromptShortcutKeys } from '../../../utils/quickPromptShortcut';
import { eventManager } from '../../../events/eventManager';
import { getVersionShowcase } from '../../../constants/versionShowcases';

interface VersionUpdateMessageContentProps {
    message: PopupMessage;
    onDismiss?: () => void;
    isFloating?: boolean;
}

const SHORTCUT_KEYS: Record<VersionShortcutId, () => string[]> = {
    'quick-prompt': quickPromptShortcutKeys,
    'beaver-window': beaverWindowShortcutKeys,
};

/** One more feature under the showcase: a row, not a checklist item. */
const AlsoNewRow: React.FC<{ item: VersionAlsoNew }> = ({ item }) => {
    const keys = item.shortcut ? SHORTCUT_KEYS[item.shortcut]() : [];
    return (
        <div className="display-flex flex-col gap-2">
            <span className="text-sm font-medium font-color-tertiary" style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Also in this release
            </span>
            <div className="display-flex flex-row gap-3 items-start">
                <Icon icon={PictureInPictureIcon} size={18} className="flex-shrink-0 mt-015 font-color-secondary" />
                <div className="display-flex flex-col gap-1 flex-1 min-w-0">
                    <div className="display-flex flex-row items-center justify-between gap-2">
                        <span className="font-color-primary text-base font-semibold">{item.title}</span>
                        {keys.length > 0 && (
                            <span className="beaver-showcase__chord beaver-showcase__chord--small flex-shrink-0">
                                {keys.map((key) => (
                                    <span key={key} className="beaver-showcase__key">{key}</span>
                                ))}
                            </span>
                        )}
                    </div>
                    {item.description && (
                        <span className="font-color-secondary text-md">
                            {parseTextWithLinksAndNewlines(item.description)}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
};

/**
 * Legacy list-based content for older version messages
 */
const LegacyVersionContent: React.FC<{
    text?: string;
    featureList?: { title: string; description?: string }[];
    learnMoreUrl?: string;
    learnMoreLabel?: string;
    footer?: string;
    Showcase?: React.ComponentType;
}> = ({ text, featureList, learnMoreUrl, learnMoreLabel, footer, Showcase }) => {
    const handleLearnMore = () => {
        if (learnMoreUrl) {
            Zotero.launchURL(learnMoreUrl);
        }
    };

    return (
        <div className="display-flex flex-col gap-5 w-full">
            {text && (
                <div className="font-color-primary text-base" style={{ whiteSpace: 'pre-line' }}>
                    {parseTextWithLinksAndNewlines(text)}
                </div>
            )}

            {Showcase && <Showcase />}

            {featureList && featureList.length > 0 && (
                <div className="display-flex flex-col gap-4">
                    {featureList.map((feature, index) => (
                        <div key={index} className="display-flex flex-row gap-2 items-start">
                            <div className="flex-shrink-0">
                                <Icon icon={TickIcon} className="scale-12 mt-020 font-color-secondary" />
                            </div>
                            <div className="display-flex flex-col gap-1">
                                <span className="font-color-primary text-base">
                                    {feature.title}
                                </span>
                                {feature.description && (
                                    <span className="font-color-secondary text-md">
                                        {parseTextWithLinksAndNewlines(feature.description)}
                                    </span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {learnMoreUrl && (
                <div className="display-flex flex-row gap-3 items-center justify-end pt-1">
                    <Button onClick={handleLearnMore} variant="outline">
                        {learnMoreLabel || 'Learn more'}
                    </Button>
                </div>
            )}

            {footer && (
                <div className="font-color-secondary text-base" style={{ whiteSpace: 'pre-line' }}>
                    {parseTextWithLinksAndNewlines(footer)}
                </div>
            )}
        </div>
    );
};

/**
 * Floating card layout for version updates shown over the main Zotero window.
 * Flattens step-based and legacy feature lists into a single feature list.
 */
const FloatingVersionCard: React.FC<{
    version?: string;
    title?: string;
    text?: string;
    subtitle?: string;
    features: PopupMessageFeature[];
    footer?: string;
    learnMoreUrl?: string;
    learnMoreLabel?: string;
    Showcase?: React.ComponentType;
    alsoNew?: VersionAlsoNew;
    primaryAction?: PopupMessage['primaryAction'];
    onDismiss: () => void;
}> = ({ version, title, text, subtitle, features, footer, learnMoreUrl, learnMoreLabel, Showcase, alsoNew, primaryAction, onDismiss }) => {
    const gate = useAtomValue(chatAccessGateAtom);
    const openQuickPrompt = useSetAtom(openQuickPromptAtom);
    const action = primaryAction ?? { type: 'open-beaver', label: 'Open Beaver' };
    const buttonLabel = action.type === 'quick-prompt' && gate
        ? (gate === 'signed-out' ? 'Sign in to try' : 'Open Beaver')
        : action.label;
    const handlePrimaryAction = () => {
        onDismiss();
        if (action.type === 'open-url') {
            Zotero.launchURL(action.url);
        } else if (action.type === 'quick-prompt' && !gate) {
            void openQuickPrompt();
        } else {
            eventManager.dispatch('toggleChat', { forceOpen: true });
        }
    };

    const handleLearnMore = () => {
        if (learnMoreUrl) {
            Zotero.launchURL(learnMoreUrl);
        }
    };

    function formatVersion(version: string): string {
        const isBeta = /-beta\.\d+$/.test(version);

        let cleanVersion = version.replace(/-beta\.\d+$/, "");

        cleanVersion = cleanVersion.replace(/\.0$/, "");

        return isBeta ? `${cleanVersion} Beta` : cleanVersion;
    }

    const versionString = version ? `Beaver v${formatVersion(version)}` : 'Now Available';

    return (
        <div className="display-flex flex-col gap-4 w-full">
            {/* Header: NOW AVAILABLE + dismiss */}
            <div className="display-flex flex-col gap-05 w-full">
                <div className="display-flex flex-row items-center justify-between w-full">
                    {version ? (
                        <span className="text-base font-semibold font-color-secondary">
                            {versionString}
                        </span>
                    ) : (
                        <span className="text-base font-medium font-color-secondary" style={{ textTransform: 'uppercase' }}>
                            {versionString}
                        </span>
                    )}
                    <IconButton
                        icon={CancelIcon}
                        variant="ghost-secondary"
                        onClick={onDismiss}
                    />
                </div>

                {/* Version title */}
                {title && (
                    <div className="font-color-primary text-xl font-semibold">
                        {title}
                    </div>
                )}
            </div>

            {/* Optional intro text */}
            {(subtitle || text) && (
                <div className="font-color-secondary text-base" style={{ whiteSpace: 'pre-line' }}>
                    {parseTextWithLinksAndNewlines(subtitle || text || '')}
                </div>
            )}

            {/* The feature itself, where the note has one to show */}
            {Showcase && <Showcase />}

            {alsoNew && <AlsoNewRow item={alsoNew} />}

            {/* Feature list */}
            {features.length > 0 && (
                <div className="display-flex flex-col gap-3">
                    {features.map((feature, index) => (
                        <div key={index} className="display-flex flex-row gap-2 items-start">
                            <div className="flex-shrink-0">
                                <Icon icon={TickIcon} className="scale-12 mt-020 font-color-primary" />
                            </div>
                            <div className="display-flex flex-col gap-1">
                                <span className="font-color-primary text-base font-semibold">
                                    {feature.title}
                                </span>
                                {feature.description && (
                                    <span className="font-color-secondary text-md">
                                        {parseTextWithLinksAndNewlines(feature.description)}
                                    </span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Footer buttons */}
            <div className="display-flex flex-row items-center justify-between pt-2" style={{ borderTop: '1px solid var(--fill-quinary)' }}>
                {learnMoreUrl && (
                    <a
                        href={learnMoreUrl}
                        className="text-link text-base"
                        onClick={(e) => {
                            e.preventDefault();
                            handleLearnMore();
                        }}
                    >
                        {learnMoreLabel || 'Learn More'}
                    </a>
                )}
                {/* Footer text */}
                {footer && (
                    <div className="font-color-tertiary text-sm" style={{ whiteSpace: 'pre-line' }}>
                        {parseTextWithLinksAndNewlines(footer)}
                    </div>
                )}
                {!footer && !learnMoreUrl && <div />}
                <Button onClick={handlePrimaryAction} variant="solid">
                    {buttonLabel}
                </Button>
            </div>
        </div>
    );
};

/**
 * Builds a flat feature list from either steps or legacy featureList.
 * Steps are flattened to title + description (examplePrompts omitted).
 */
function buildFeatureList(message: PopupMessage): PopupMessageFeature[] {
    const { steps, featureList } = message;
    if (steps && steps.length > 0) {
        return steps.map((step) => ({
            title: step.title,
            description: step.description,
        }));
    }
    return featureList ?? [];
}

const VersionUpdateMessageContent: React.FC<VersionUpdateMessageContentProps> = ({ message, onDismiss, isFloating }) => {
    const { version, text, featureList, learnMoreUrl, learnMoreLabel, footer, steps, subtitle } = message;
    const Showcase = getVersionShowcase(message.showcase);

    // Floating mode: render the card layout
    if (isFloating) {
        return (
            <FloatingVersionCard
                version={version}
                title={message.title}
                text={text}
                subtitle={subtitle}
                features={buildFeatureList(message)}
                footer={footer}
                learnMoreUrl={learnMoreUrl}
                learnMoreLabel={learnMoreLabel}
                Showcase={Showcase}
                alsoNew={message.alsoNew}
                primaryAction={message.primaryAction}
                onDismiss={onDismiss || (() => {})}
            />
        );
    }

    // Sidebar: step-based format
    const usesStepFormat = steps && steps.length > 0;

    if (usesStepFormat) {
        return (
            <div className="display-flex flex-col gap-4 w-full">
                {subtitle && (
                    <p className="font-color-secondary text-base m-0">
                        {parseTextWithLinksAndNewlines(subtitle)}
                    </p>
                )}
                {Showcase && <Showcase />}
                <FeatureTourContent
                    steps={steps as FeatureStep[]}
                    onComplete={onDismiss || (() => {})}
                    footer={footer}
                />
            </div>
        );
    }

    // Legacy format
    if (!text && (!featureList || featureList.length === 0) && !learnMoreUrl && !Showcase) {
        return null;
    }

    return (
        <LegacyVersionContent
            text={text}
            featureList={featureList}
            learnMoreUrl={learnMoreUrl}
            learnMoreLabel={learnMoreLabel}
            footer={footer}
            Showcase={Showcase}
        />
    );
};

export default VersionUpdateMessageContent;
