import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import { SectionLabel, SettingsGroup, SettingsRow } from '../preferences/components/SettingsElements';
import { CheckmarkCircleSolidIcon, Icon } from '../icons/icons';
import { featureCreditEntriesAtom, featureCreditTotalsAtom, featureTaskModelAccessAtom, startFeatureTaskAtom } from '../../atoms/featureCredits';
import { canRunFeatureTasks } from '../../utils/featureCredits';
import { newThreadAtom } from '../../atoms/threads';
import { eventManager } from '../../events/eventManager';

/**
 * "Earn credits" in Plan & Usage: the feature-credit tasks, with what each
 * has earned. Not dismissible; gone once every task is done.
 */
const EarnCreditsSection: React.FC = () => {
    const entries = useAtomValue(featureCreditEntriesAtom);
    const totals = useAtomValue(featureCreditTotalsAtom);
    const startTask = useSetAtom(startFeatureTaskAtom);
    const newThread = useSetAtom(newThreadAtom);
    const canRun = canRunFeatureTasks(useAtomValue(featureTaskModelAccessAtom));

    if (!entries || totals.done === totals.count) return null;

    const start = async (key: string) => {
        // Preferences shares the chat window's store: open its chat on a new
        // thread and stage the task there.
        eventManager.dispatch('toggleChat', { forceOpen: true });
        if ((await newThread({})) === undefined) return;
        startTask({ key });
    };

    return (
        <>
            <SectionLabel>Earn credits</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title={`${totals.earned} of ${totals.total} earned`}
                    description={
                        <span className="font-color-secondary">
                            Learn {entries.length === 4 ? 'four' : entries.length} skills. Each earns credits once you
                            accept Beaver's changes, whether you start from here or on your own.
                            {!canRun && (
                                <>
                                    {' '}Each task needs a few credits to run, or your own API key, and pays them back.
                                </>
                            )}
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
                                    Start in a chat · +{task.credits}
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
