import React, { useEffect, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { ArrowLeftIcon, ArrowRightIcon, CancelIcon, CheckmarkCircleSolidIcon, CircleIcon, FolderAddIcon, HighlighterIcon, Icon, LayersIcon, QuillWriteIcon, Spinner, TableIcon, TickIcon } from '../icons/icons';
import {
    featureCreditEntriesAtom,
    featureCreditsCardDismissedAtom,
    featureCreditTotalsAtom,
    featureTaskAttachedPapersAtom,
    featureTaskSetupStepsAtom,
    featureTaskUnavailableAtom,
    leaveFeatureTaskAtom,
    lookUpOcrPreparedPdfsAtom,
    startFeatureTaskAtom,
    type FeatureCreditEntry,
} from '../../atoms/featureCredits';
import { activeFeatureTaskAtom } from '../../atoms/featureCreditRuns';
import { selectBeaverModelAtom } from '../../atoms/models';
import { currentMessagePillsAtom, pendingPillInsertsAtom } from '../../atoms/messageComposition';
import { searchableLibraryIdsAtom } from '../../atoms/profile';
import { completeCreditsFirstRunAtom } from '../../atoms/firstRun';
import { CREDITS_DOCS_URL, examplesForLibrary, getFeatureCreditTask, type FeatureTaskDefinition, type FeatureTaskExample, type LibraryShape } from '../../constants/featureCreditTasks';
import type { SetupStep, StepStatus } from '../../utils/featureCredits';
import { readLibraryShape } from '../../utils/libraryShape';
import { SMALL_LIBRARY_THRESHOLD } from '../../atoms/zoteroContext';

const TASK_ICONS: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
    literature_review: QuillWriteIcon,
    annotate: HighlighterIcon,
    start_project: FolderAddIcon,
    organize: LayersIcon,
    research_table: TableIcon,
};

/** One task in the list: done, or a button that opens its setup card. */
const TaskRow: React.FC<{
    entry: FeatureCreditEntry;
    onStart: (key: string, win: Window | null) => void;
}> = ({ entry, onStart }) => {
    const { task, definition } = entry;
    const done = !!task.completed_at;
    const body = (
        <>
            <Icon
                icon={done ? CheckmarkCircleSolidIcon : (TASK_ICONS[definition.key] ?? CircleIcon)}
                className={`feature-credits-row-mark scale-12 ${done ? 'font-color-green' : 'font-color-primary'}`}
                aria-label={done ? 'Done' : undefined}
            />
            <span className="feature-credits-row-text">
                <span className={done ? 'font-color-secondary text-base' : 'font-color-primary font-medium text-base'}>{definition.title}</span>
                <span className="feature-credits-row-subtitle">{definition.subtitle}</span>
            </span>
            {!done && <Icon icon={ArrowRightIcon} className="feature-credits-row-arrow font-color-secondary" />}
        </>
    );
    if (done) return <li className="feature-credits-row">{body}</li>;
    return (
        <li>
            <button
                type="button"
                className="feature-credits-row feature-credits-row-button"
                onClick={(event) => onStart(definition.key, event.currentTarget.ownerDocument.defaultView)}
            >
                {body}
            </button>
        </li>
    );
};

const StepMarker: React.FC<{ status: StepStatus; number: number }> = ({ status, number }) => (
    <span className={`feature-credits-step-marker is-${status}`} aria-hidden="true">
        {status === 'done' ? <Icon icon={TickIcon} className="scale-11" />
            : status === 'checking' ? <Spinner size={12} />
            : number}
    </span>
);

/**
 * The setup card, the same for every task: numbered steps (the model when a
 * task needs it, the PDF for a task that works on one, what Beaver should do)
 * that turn into checks as they are done, then one line on the reward. The
 * first open required step is accented; required steps hold Send (see
 * `featureTaskSendBlockAtom`).
 */
const SetupView: React.FC<{ definition: FeatureTaskDefinition; credits: number; onBack: () => void }> = ({ definition, credits, onBack }) => {
    const steps = useAtomValue(featureTaskSetupStepsAtom);
    const startTask = useSetAtom(startFeatureTaskAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const selectBeaverModel = useSetAtom(selectBeaverModelAtom);
    const [shape, setShape] = useState<LibraryShape | null>(null);
    const needsShape = definition.examples.some((example) => example.when);

    useEffect(() => {
        if (!needsShape) return;
        let cancelled = false;
        void readLibraryShape(searchableLibraryIds).then((value) => {
            if (!cancelled) setShape(value);
        });
        return () => {
            cancelled = true;
        };
    }, [needsShape, searchableLibraryIds]);

    // A scan reads like any other PDF but cannot be highlighted: the PDF step
    // needs to know where each attached PDF's text comes from.
    const worksOnPdf = definition.attach === 'pdf';
    const papers = useAtomValue(featureTaskAttachedPapersAtom);
    const lookUpOcrPreparedPdfs = useSetAtom(lookUpOcrPreparedPdfsAtom);
    useEffect(() => {
        if (worksOnPdf) void lookUpOcrPreparedPdfs();
    }, [worksOnPdf, papers, lookUpOcrPreparedPdfs]);

    if (!steps) return null;
    const examples = examplesForLibrary(definition, shape);

    const applyExample = (example: FeatureTaskExample, event: React.MouseEvent<HTMLElement>) => {
        event.preventDefault();
        startTask({
            key: definition.key,
            targetWindow: event.currentTarget.ownerDocument.defaultView ?? undefined,
            argumentText: example.text,
        });
    };

    const stepBody = (step: SetupStep) => {
        if (step.key === 'model') {
            return (
                <>
                    {step.text}{' '}
                    <a href="#" className="feature-credits-link" onClick={(event) => { event.preventDefault(); selectBeaverModel(); }}>
                        Switch to it
                    </a>
                </>
            );
        }
        if (step.key === 'source' || step.hideExamples || examples.length === 0) return step.text;
        return (
            <>
                {step.text}
                <ul className="feature-credits-examples" aria-label="Examples">
                    {examples.map((example) => (
                        <li key={example.text}>
                            <button
                                type="button"
                                className="feature-credits-example"
                                onClick={(event) => applyExample(example, event)}
                            >
                                {example.text}
                            </button>
                        </li>
                    ))}
                </ul>
            </>
        );
    };

    return (
        <>
            {/* The whole header goes back to the task list, not just its arrow. */}
            <h2 className="feature-credits-back-heading">
                <button type="button" className="feature-credits-header feature-credits-back" onClick={onBack}>
                    <span className="feature-credits-back-icon" aria-hidden="true">
                        <Icon icon={ArrowLeftIcon} />
                    </span>
                    <span className="sr-only">Back to all tasks: </span>
                    <span className="feature-credits-title">{definition.title}</span>
                </button>
            </h2>
            <ol className="feature-credits-steps">
                {steps.map((step, index) => (
                    <li key={step.key} className={`feature-credits-step is-${step.status}`}>
                        <StepMarker status={step.status} number={index + 1} />
                        <div className="feature-credits-step-body">
                            <h3 className="feature-credits-step-title">
                                {step.status === 'done' && <span className="sr-only">Done: </span>}
                                {step.title}
                                {!step.requiredHint && <span className="feature-credits-step-optional"> (optional)</span>}
                            </h3>
                            <div className="feature-credits-step-text">{stepBody(step)}</div>
                        </div>
                    </li>
                ))}
            </ol>
            <p className="feature-credits-reward">
                Send to earn {credits} free credits.
                {definition.footnote && <> {definition.footnote}</>}
            </p>
        </>
    );
};

/**
 * "Try Beaver and earn free credits": the feature-credit tasks on the home screen.
 *
 * The list shows each skill; clicking an open one stages its action in the
 * chat input and swaps the list for that task's setup card. The setup ends
 * when the user goes back or removes the /command from the chat input.
 */
const FeatureCreditsCard: React.FC = () => {
    const entries = useAtomValue(featureCreditEntriesAtom);
    const totals = useAtomValue(featureCreditTotalsAtom);
    const [activeKey, setActiveKey] = useAtom(activeFeatureTaskAtom);
    const setDismissed = useSetAtom(featureCreditsCardDismissedAtom);
    const isUnavailable = useAtomValue(featureTaskUnavailableAtom);
    const completeCreditsFirstRun = useSetAtom(completeCreditsFirstRunAtom);
    const startTask = useSetAtom(startFeatureTaskAtom);
    const leaveTask = useSetAtom(leaveFeatureTaskAtom);
    const pills = useAtomValue(currentMessagePillsAtom);
    const pendingPills = useAtomValue(pendingPillInsertsAtom);

    const activeEntry = activeKey ? entries?.find((entry) => entry.definition.key === activeKey) : undefined;
    const activeDefinition = activeKey ? getFeatureCreditTask(activeKey) : undefined;

    // The setup follows its /command: once the pill has been in the chat
    // input, removing it ends the setup.
    const pillSeenRef = useRef(false);
    const actionId = activeDefinition?.actionId;
    const hasPill = !!actionId && pills.some((pill) => pill.actionId === actionId);
    const pillPending = !!actionId && pendingPills.some((pending) => pending.descriptor.actionId === actionId);
    useEffect(() => {
        if (!actionId) {
            pillSeenRef.current = false;
            return;
        }
        if (hasPill) pillSeenRef.current = true;
        else if (pillSeenRef.current && !pillPending) {
            pillSeenRef.current = false;
            setActiveKey(null);
        }
    }, [actionId, hasPill, pillPending, setActiveKey]);

    // A task that was completed (or is unknown) while its setup was open
    // returns to the list.
    useEffect(() => {
        if (activeKey && (!activeEntry || activeEntry.task.completed_at)) setActiveKey(null);
    }, [activeKey, activeEntry, setActiveKey]);

    const showSetup = !!(activeEntry && activeDefinition && !activeEntry.task.completed_at);

    if (!entries) return null;

    // Picking a task, or closing the list, ends a feature-credits first run.
    const onStart = (key: string, win: Window | null) => {
        pillSeenRef.current = false;
        startTask({ key, targetWindow: win ?? undefined });
        void completeCreditsFirstRun(key);
    };

    const dismiss = () => {
        setDismissed(true);
        void completeCreditsFirstRun('dismiss');
    };

    if (showSetup && activeEntry && activeDefinition) {
        return (
            <section className="home-tray feature-credits-home" aria-label={`${activeDefinition.title}: how to start`}>
                <SetupView definition={activeDefinition} credits={activeEntry.task.credits} onBack={leaveTask} />
            </section>
        );
    }

    // Tasks that cannot start yet stay out of the list; a line says how many.
    const listed = entries.filter((entry) => entry.task.completed_at || !isUnavailable(entry.definition));
    const locked = entries.length - listed.length;

    // What each open task earns, when they all earn the same.
    const openAmounts = new Set(entries.filter((entry) => !entry.task.completed_at).map((entry) => entry.task.credits));
    const perTask = openAmounts.size === 1 ? [...openAmounts][0] : null;

    return (
        <section className="home-tray feature-credits-home" aria-labelledby="feature-credits-title">
            <div className="feature-credits-header">
                <h2 id="feature-credits-title" className="feature-credits-title">
                    Try Beaver and earn {totals.total - totals.earned} {totals.earned > 0 ? 'more ' : ''}free credits
                </h2>
                <IconButton icon={CancelIcon} variant="ghost-secondary" ariaLabel="Dismiss" onClick={dismiss} />
            </div>
            <p className="feature-credits-text">
                {perTask !== null ? `Each task earns ${perTask} credits.` : 'Each task earns credits.'}
                {' '}Most messages cost 1.{' '}
                <a
                    href={CREDITS_DOCS_URL}
                    className="feature-credits-link"
                    onClick={(event) => {
                        event.preventDefault();
                        Zotero.launchURL(CREDITS_DOCS_URL);
                    }}
                >
                    Learn more
                </a>
            </p>
            <ul className="feature-credits-list">
                {listed.map((entry) => (
                    <TaskRow key={entry.definition.key} entry={entry} onStart={onStart} />
                ))}
            </ul>
            {locked > 0 && (
                <p className="feature-credits-text font-color-secondary">
                    {locked === 1 ? '1 more task unlocks' : `${locked} more tasks unlock`} once your library has {SMALL_LIBRARY_THRESHOLD} items.
                </p>
            )}
        </section>
    );
};

export default FeatureCreditsCard;
