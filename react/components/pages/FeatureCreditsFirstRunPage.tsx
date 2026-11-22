import React, { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { runsCountAtom } from '@beaver/agent-core/run-state/atoms';
import { featureCreditsCardDismissedAtom, firstRunFeatureTasksAtom, startFeatureTaskAtom } from '../../atoms/featureCredits';
import { firstRunPreviewAtom, markFirstRunCompleteAtom } from '../../atoms/firstRun';
import { searchableLibraryIdsAtom } from '../../atoms/profile';
import { newThreadAtom } from '../../atoms/threads';
import { SMALL_LIBRARY_THRESHOLD } from '../../atoms/zoteroContext';
import { countLibraryItems } from '../../utils/libraryShape';
import { firstRunOfferedTasks } from '../../utils/featureCredits';
import { TaskRow } from '../featureCredits/FeatureCreditsCard';
import { OnboardingFooter } from './onboarding';
import WhereToStartPage from './WhereToStartPage';
import { logger } from '@beaver/agent-core/platform/logger';

/**
 * First run with the feature-credit tasks: the user picks a task, which ends
 * first run and opens the task's setup card on the home screen, or skips.
 * Shown only while `firstRunFeatureTasksAtom` has tasks to offer.
 */
const FeatureCreditsFirstRunPage: React.FC = () => {
    const entries = useAtomValue(firstRunFeatureTasksAtom);
    const markComplete = useSetAtom(markFirstRunCompleteAtom);
    const setPreview = useSetAtom(firstRunPreviewAtom);
    const startTask = useSetAtom(startFeatureTaskAtom);
    const setCardDismissed = useSetAtom(featureCreditsCardDismissedAtom);
    const runsCount = useAtomValue(runsCountAtom);
    const newThread = useSetAtom(newThreadAtom);
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Below the small-library threshold only tasks that need no papers are
    // offered. Counted over the libraries Beaver can access; a failed count
    // reads as a small library.
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const [libraryReady, setLibraryReady] = useState<boolean | null>(null);
    useEffect(() => {
        let cancelled = false;
        setLibraryReady(null);
        void countLibraryItems(SMALL_LIBRARY_THRESHOLD, searchableLibraryIds).then((count) => {
            if (!cancelled) setLibraryReady(count !== null && count >= SMALL_LIBRARY_THRESHOLD);
        });
        return () => {
            cancelled = true;
        };
    }, [searchableLibraryIds]);
    const tasks = entries && libraryReady !== null ? firstRunOfferedTasks(entries, libraryReady) : null;

    // The completion kind names the choice: `feature_credits_<task key>` or
    // `feature_credits_skip`. A task's setup card is on Home, so an open chat
    // is left first; nothing happens when the user cancels leaving it. Skip
    // also dismisses the home card, as its close button does; Plan & Usage
    // brings the tasks back.
    const finish = async (choice: string, task?: { key: string; win: Window | null }) => {
        if (pending) return;
        setPending(choice);
        setError(null);
        try {
            if (task && runsCount > 0 && (await newThread()) === undefined) return;
            await markComplete(`feature_credits_${choice}`);
            setPreview(null);
            if (task) startTask({ key: task.key, targetWindow: task.win ?? undefined });
            else setCardDismissed(true);
        } catch (err) {
            logger(`FeatureCreditsFirstRunPage: completion failed: ${err}`, 1);
            setError('Failed to connect to Beaver. Please try again.');
        } finally {
            setPending(null);
        }
    };

    const open = tasks?.filter(({ task }) => !task.completed_at) ?? [];
    // A small library whose no-paper tasks are done has nothing to try here.
    if (tasks && open.length === 0) return <WhereToStartPage />;
    const amounts = new Set(open.map(({ task }) => task.credits));
    const total = open.reduce((sum, { task }) => sum + task.credits, 0);
    const subtitle = open.length === 1
        ? `Start with the task below. It's worth ${total} credits the first time you send it.`
        : amounts.size === 1
            ? `Pick a task. Each is worth ${[...amounts][0]} credits the first time you send it.`
            : `Pick a task. Together they're worth ${total} credits.`;

    return (
        <div className="first-run-page display-flex flex-col flex-1 min-h-0 min-w-0">
            <div className="first-run-scroll overflow-y-auto scrollbar flex-1 min-h-0">
                <div className="first-run-shell">
                    <div className="flex-1" style={{ minHeight: '4vh', maxHeight: '6vh' }} />
                    <div className="first-run-heading">
                        <div className="first-run-title">Try Beaver and earn free credits</div>
                        {tasks && <div className="first-run-subtitle">{subtitle}</div>}
                    </div>
                    <div className="first-run-card">
                        {tasks ? (
                            <ul className="feature-credits-list" aria-label="Tasks">
                                {tasks.map((entry) => (
                                    <TaskRow
                                        key={entry.definition.key}
                                        entry={entry}
                                        onStart={(key, win) => void finish(key, { key, win })}
                                        disabled={pending !== null}
                                    />
                                ))}
                            </ul>
                        ) : (
                            <div className="first-run-loader" aria-label="Loading tasks">
                                <div className="first-run-loader-row" />
                                <div className="first-run-loader-row" />
                                <div className="first-run-loader-row" />
                            </div>
                        )}
                    </div>
                </div>
            </div>
            <OnboardingFooter
                message={error ?? undefined}
                buttonLabel="Skip"
                buttonVariant="outline"
                hideRightIcon
                onButtonClick={() => void finish('skip')}
                isLoading={pending === 'skip'}
                disabled={pending !== null || !tasks}
            />
        </div>
    );
};

export default FeatureCreditsFirstRunPage;
