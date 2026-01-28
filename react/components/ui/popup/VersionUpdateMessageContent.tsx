import React from 'react';
import { TickIcon } from '../../icons/icons';
import Icon from '../../icons/Icon';
import { PopupMessage } from '../../../types/popupMessage';
import Button from "../Button";
import { parseTextWithLinksAndNewlines } from '../../../utils/parseTextWithLinksAndNewlines';
import FeatureTourContent from './FeatureTourContent';
import { FeatureStep } from '../../../constants/versionUpdateMessages';

interface VersionUpdateMessageContentProps {
    message: PopupMessage;
    onDismiss?: () => void;
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

const VersionUpdateMessageContent: React.FC<VersionUpdateMessageContentProps> = ({ message, onDismiss }) => {
    const { text, featureList, learnMoreUrl, learnMoreLabel, footer, steps, subtitle } = message;
    
    // Check if this message uses the new step-based format
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
