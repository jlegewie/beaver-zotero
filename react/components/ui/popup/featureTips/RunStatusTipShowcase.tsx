import React from 'react';
import { useAtomValue } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import { eventManager } from '../../../../events/eventManager';
import { isSidebarVisibleAtom } from '../../../../atoms/ui';
import RunPulse from '../../../runStatusPopup/RunPulse';
import type { FeatureTipActionsProps } from '../../../../constants/featureTips';

/**
 * The corner card's top-left, built from the card's own classes so it stays
 * true to the real thing, cut off and faded where the tip runs out of room.
 */
const RunStatusTipShowcase: React.FC = () => (
    <div className="beaver-run-status-tip__preview" aria-hidden="true">
        <div className="beaver-run-status-tip__preview-clip">
            <div className="beaver-run-status-popup__card beaver-run-status-tip__preview-card">
                <div className="beaver-run-status-popup__content">
                    <div className="beaver-run-status-popup__header">
                        <div className="beaver-run-status-popup__leading"><RunPulse /></div>
                        <div className="beaver-run-status-popup__text">
                            <div className="beaver-run-status-popup__title font-color-primary">
                                Summarizing the neighborhood effects literature
                            </div>
                            <div className="beaver-run-status-popup__detail font-color-secondary">
                                <span className="shimmer-text">Reading Sampson 2012, p. 31-48</span>
                            </div>
                        </div>
                    </div>
                    <div className="beaver-run-status-popup__footer">
                        <div className="flex-1" />
                        <Button variant="outline" style={{ padding: '2px 10px', fontSize: '0.875rem' }} tabIndex={-1}>
                            Reject
                        </Button>
                        <Button variant="solid" style={{ padding: '2px 10px', fontSize: '0.875rem' }} tabIndex={-1}>
                            Approve
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    </div>
);

/** "Got it", and — while the sidebar is open — the offer to try it right now. */
export const RunStatusTipActions: React.FC<FeatureTipActionsProps> = ({ dismiss }) => {
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const handleCloseSidebar = () => {
        if (isSidebarVisible) eventManager.dispatch('toggleChat', {});
        dismiss();
    };
    return (
        <>
            <Button variant="ghost-secondary" onClick={dismiss} style={{ padding: '3px 8px' }}>
                Got it
            </Button>
            {isSidebarVisible && (
                <Button variant="solid" onClick={handleCloseSidebar} style={{ padding: '3px 10px' }}>
                    Close sidebar
                </Button>
            )}
        </>
    );
};

export default RunStatusTipShowcase;
