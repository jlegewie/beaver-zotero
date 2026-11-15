import React, { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import { SectionLabel, SettingsGroup, SettingsRow } from '../preferences/components/SettingsElements';
import { CheckmarkCircleSolidIcon, Icon } from '../icons/icons';
import { featureCreditEntriesAtom, featureCreditTotalsAtom } from '../../atoms/featureCredits';
import { useStartFeatureTaskInNewChat } from '../../hooks/useStartFeatureTaskInNewChat';

/**
 * "Earn credits" in Plan & Usage: the feature-credit tasks, with what each
 * has earned. Not dismissible; gone once every task is done.
 */
const EarnCreditsSection: React.FC = () => {
    const entries = useAtomValue(featureCreditEntriesAtom);
    const totals = useAtomValue(featureCreditTotalsAtom);
    // Preferences shares the chat window's store: the task starts in its chat.
    const start = useStartFeatureTaskInNewChat();
    const shown = !!entries && totals.done < totals.count;

    // Seeing the tasks here counts as seeing the offer.
    useEffect(() => {
        if (shown) Zotero.Beaver?.account?.markFeatureCreditsCardSeen();
    }, [shown]);

    if (!entries || !shown) return null;

    return (
        <>
            <SectionLabel>Earn credits</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title={`${totals.earned} of ${totals.total} earned`}
                    description={
                        <span className="font-color-secondary">
                            Start a skill here or from the home screen card. Its credits are added as soon as you send it.
                        </span>
                    }
                />
                {entries.map(({ task, definition }) => (
                    <SettingsRow
                        key={definition.key}
                        hasBorder
                        title={definition.title}
                        description={<span className="font-color-secondary">{definition.subtitle}</span>}
                        control={
                            task.completed_at ? (
                                <span className="display-flex flex-row items-center gap-1 text-sm font-color-secondary">
                                    <Icon icon={CheckmarkCircleSolidIcon} className="font-color-green" />
                                    Earned {new Date(task.completed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                </span>
                            ) : (
                                <Button
                                    variant="outline"
                                    onClick={() => void start(definition.key)}
                                    style={{ padding: '4px 6px' }}
                                    ariaLabel={`Start ${definition.title} in a chat (+${task.credits} credits)`}
                                >
                                    Start (+{task.credits})
                                </Button>
                            )
                        }
                    />
                ))}
            </SettingsGroup>
        </>
    );
};

export default EarnCreditsSection;
