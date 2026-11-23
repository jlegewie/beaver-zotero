import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { ArrowRightIcon, CancelIcon, Icon } from '../icons/icons';
import {
    featureCreditsCardDismissedAtom,
    featureCreditsTeaserDoneAtom,
    featureCreditTotalsAtom,
} from '../../atoms/featureCredits';

/**
 * One line under the chat input that leads someone who already uses Beaver to
 * the feature-credit tasks, shown once per device (see
 * `featureCreditsTeaserVisibleAtom`). Opening it shows the task card in its
 * place; dismissing it hides both, and Plan & Usage brings the card back.
 */
const FeatureCreditsTeaser: React.FC = () => {
    const totals = useAtomValue(featureCreditTotalsAtom);
    const setDone = useSetAtom(featureCreditsTeaserDoneAtom);
    const setDismissed = useSetAtom(featureCreditsCardDismissedAtom);
    const openCount = totals.count - totals.done;

    return (
        <section className="feature-credits-card feature-credits-home feature-credits-teaser" aria-label="Free credits">
            <div className="feature-credits-header">
                <button type="button" className="feature-credits-row feature-credits-row-button" onClick={() => setDone(true)}>
                    <span className="feature-credits-teaser-text">
                        Earn free credits with {openCount} {openCount === 1 ? 'task' : 'tasks'}
                    </span>
                    <Icon icon={ArrowRightIcon} className="feature-credits-row-arrow" />
                </button>
                <IconButton icon={CancelIcon} variant="ghost-secondary" ariaLabel="Dismiss" onClick={() => setDismissed(true)} />
            </div>
        </section>
    );
};

export default FeatureCreditsTeaser;
