import React from 'react';
import { useAtomValue } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import { SectionLabel, SettingsGroup, SettingsRow } from '../preferences/components/SettingsElements';
import { featureCreditEntriesAtom, featureCreditTotalsAtom } from '../../atoms/featureCredits';
import { allLibrariesExcludedAtom } from '../../atoms/profile';
import { useShowFeatureCreditsCard } from '../../hooks/useShowFeatureCreditsCard';

/**
 * "Earn credits" in Plan & Usage: progress on the feature-credit tasks and a
 * button that shows them on the chat's home screen. Gone once every task is
 * done.
 */
const EarnCreditsSection: React.FC = () => {
    const entries = useAtomValue(featureCreditEntriesAtom);
    const totals = useAtomValue(featureCreditTotalsAtom);
    const allLibrariesExcluded = useAtomValue(allLibrariesExcludedAtom);
    // Preferences shares the chat window's store: the tasks show in its chat.
    const showCard = useShowFeatureCreditsCard();

    if (!entries || totals.done >= totals.count) return null;

    const left = totals.count - totals.done;
    const progress = totals.earned > 0
        ? `You've earned ${totals.earned} of ${totals.total} free credits. ${left} ${left === 1 ? 'task' : 'tasks'} left.`
        : `Try Beaver's skills and earn up to ${totals.total} free credits.`;

    return (
        <>
            <SectionLabel>Earn credits</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title="Earn free credits"
                    description={
                        <span className="font-color-secondary">
                            {allLibrariesExcluded
                                ? 'The tasks need a library Beaver can access.'
                                : progress}
                        </span>
                    }
                    control={
                        <Button
                            variant="outline"
                            onClick={() => void showCard()}
                            disabled={allLibrariesExcluded}
                            style={{ padding: '4px 6px' }}
                        >
                            Show tasks
                        </Button>
                    }
                />
            </SettingsGroup>
        </>
    );
};

export default EarnCreditsSection;
