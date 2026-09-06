import React from 'react';
import { CancelIcon, Icon } from '../../icons/icons';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Button from '@beaver/agent-ui/primitives/Button';
import { FEATURE_TIPS, type FeatureTipId } from '../../../constants/featureTips';

interface FeatureTipContentProps {
    tipId: FeatureTipId;
    onDismiss: () => void;
}

/**
 * A feature tip, in the panel or floating: icon and title, a line of text,
 * the tip's showcase if it has one, and its buttons. The definition supplies
 * the parts; this is the frame they share.
 */
const FeatureTipContent: React.FC<FeatureTipContentProps> = ({ tipId, onDismiss }) => {
    const tip = FEATURE_TIPS[tipId];
    if (!tip) return null;
    const { Showcase, Actions } = tip;

    return (
        <div className="display-flex flex-col gap-3 w-full">
            <div className="display-flex flex-row items-center justify-between w-full gap-2">
                <div className="display-flex flex-row gap-2 items-center min-w-0">
                    <Icon icon={tip.icon} size={18} className="font-color-secondary" />
                    <span className="font-color-primary text-lg font-medium truncate">{tip.title}</span>
                </div>
                <IconButton icon={CancelIcon} variant="ghost-secondary" onClick={onDismiss} ariaLabel="Dismiss" />
            </div>

            <div className="font-color-secondary text-base">{tip.text}</div>

            {Showcase && <Showcase />}

            <div className="display-flex flex-row items-center justify-end gap-2 w-full">
                {Actions
                    ? <Actions dismiss={onDismiss} />
                    : (
                        <Button variant="outline" onClick={onDismiss} style={{ padding: '3px 10px' }}>
                            Got it
                        </Button>
                    )}
            </div>
        </div>
    );
};

export default FeatureTipContent;
