import React from 'react';
import { TickIcon } from '../../icons/icons';
import Icon from '../../icons/Icon';
import { PopupMessage } from '../../../types/popupMessage';
import Button from "../Button";

interface VersionUpdateMessageContentProps {
    message: PopupMessage;
}

const VersionUpdateMessageContent: React.FC<VersionUpdateMessageContentProps> = ({ message }) => {
    const { text, featureList, learnMoreUrl, learnMoreLabel } = message;

    const handleLearnMore = () => {
        if (learnMoreUrl) {
            Zotero.launchURL(learnMoreUrl);
        }
    };

    if (!text && (!featureList || featureList.length === 0) && !learnMoreUrl) {
        return null;
    }

    return (
        <div className="display-flex flex-col gap-5 w-full">
            {text && (
                <div className="font-color-tertiary text-base" style={{ whiteSpace: 'pre-line' }}>
                    {text}
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
                                        {feature.description}
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
        </div>
    );
};

export default VersionUpdateMessageContent;
