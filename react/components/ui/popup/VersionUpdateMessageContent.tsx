import React from 'react';
import { TickIcon, CancelIcon } from '../../icons/icons';
import Icon from '../../icons/Icon';
import { PopupMessage, PopupMessageFeature } from '../../../types/popupMessage';
import Button from "../Button";
import IconButton from '../IconButton';
import { parseTextWithLinksAndNewlines } from '../../../utils/parseTextWithLinksAndNewlines';
import FeatureTourContent from './FeatureTourContent';
import { FeatureStep } from '../../../constants/versionUpdateMessages';
import { eventManager } from '../../../events/eventManager';

interface VersionUpdateMessageContentProps {
    message: PopupMessage;
    onDismiss?: () => void;
    isFloating?: boolean;
}

/**
 * Legacy list-based content for older version messages
 */
const LegacyVersionContent: React.FC<{
    text?: string;
    featureList?: { title: string; description?: string }[];
    learnMoreUrl?: string;
    learnMoreLabel?: string;
    footer?: string;
}> = ({ text, featureList, learnMoreUrl, learnMoreLabel, footer }) => {
    const handleLearnMore = () => {
        if (learnMoreUrl) {
            Zotero.launchURL(learnMoreUrl);
        }
    };

    return (
        <div className="display-flex flex-col gap-5 w-full">
            {text && (
                <div className="font-color-secondary text-base" style={{ whiteSpace: 'pre-line' }}>
                    {parseTextWithLinksAndNewlines(text)}
                </div>
            )}

            {featureList && featureList.length > 0 && (
                <div className="display-flex flex-col gap-4">
                    {featureList.map((feature, index) => (
                        <div key={index} className="display-flex flex-row gap-2 items-start">
                            <div className="flex-shrink-0">
                                <Icon icon={TickIcon} className="scale-12 mt-020 font-color-secondary" />
                            </div>
                            <div className="display-flex flex-col gap-1">
                                <span className="font-color-secondary text-base">
                                    {feature.title}
                                </span>
                                {feature.description && (
                                    <span className="font-color-tertiary text-md">
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
    title?: string;
    text?: string;
    subtitle?: string;
    features: PopupMessageFeature[];
    footer?: string;
    learnMoreUrl?: string;
    learnMoreLabel?: string;
    onDismiss: () => void;
}> = ({ title, text, subtitle, features, footer, learnMoreUrl, learnMoreLabel, onDismiss }) => {
    const handleOpenBeaver = () => {
        eventManager.dispatch('toggleChat', { forceOpen: true });
        onDismiss();
    };

    const handleLearnMore = () => {
        if (learnMoreUrl) {
            Zotero.launchURL(learnMoreUrl);
        }
    };

    return (
        <div className="display-flex flex-col gap-4 w-full">
            {/* Header: NOW AVAILABLE + dismiss */}
            <div className="display-flex flex-col gap-05 w-full">
                <div className="display-flex flex-row items-center justify-between w-full">
                    <span className="text-sm font-medium font-color-tertiary" style={{ textTransform: 'uppercase' }}>
                        Now Available
                    </span>
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

            {/* Feature list */}
            {features.length > 0 && (
                <div className="display-flex flex-col gap-3">
                    {features.map((feature, index) => (
                        <div key={index} className="display-flex flex-row gap-2 items-start">
                            <div className="flex-shrink-0">
                                <Icon icon={TickIcon} className="scale-12 mt-020 font-color-secondary" />
                            </div>
                            <div className="display-flex flex-col gap-1">
                                <span className="font-color-secondary text-base font-medium">
                                    {feature.title}
                                </span>
                                {feature.description && (
                                    <span className="font-color-tertiary text-md">
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
                <Button onClick={handleOpenBeaver} variant="solid">
                    Open Beaver
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
    const { text, featureList, learnMoreUrl, learnMoreLabel, footer, steps, subtitle } = message;

    // Floating mode: render the card layout
    if (isFloating) {
        return (
            <FloatingVersionCard
                title={message.title}
                text={text}
                subtitle={subtitle}
                features={buildFeatureList(message)}
                footer={footer}
                learnMoreUrl={learnMoreUrl}
                learnMoreLabel={learnMoreLabel}
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
                <FeatureTourContent
                    steps={steps as FeatureStep[]}
                    onComplete={onDismiss || (() => {})}
                    footer={footer}
                />
            </div>
        );
    }

    // Legacy format
    if (!text && (!featureList || featureList.length === 0) && !learnMoreUrl) {
        return null;
    }

    return (
        <LegacyVersionContent
            text={text}
            featureList={featureList}
            learnMoreUrl={learnMoreUrl}
            learnMoreLabel={learnMoreLabel}
            footer={footer}
        />
    );
};

export default VersionUpdateMessageContent;
