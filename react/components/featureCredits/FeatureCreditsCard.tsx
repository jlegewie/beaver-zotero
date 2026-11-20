import React, { useEffect, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { ArrowLeftIcon, ArrowRightIcon, CancelIcon, CheckmarkCircleSolidIcon, CircleIcon, HighlighterIcon, Icon, LayersIcon, QuillWriteIcon, Spinner, TableIcon, TickIcon } from '../icons/icons';
import {
    featureCreditEntriesAtom,
    featureCreditsCardDismissedAtom,
    featureTaskAttachmentSummaryAtom,
    selectBeaverModelAtom,
    startFeatureTaskAtom,
    type FeatureCreditEntry,
} from '../../atoms/featureCredits';
import { activeFeatureTaskAtom } from '../../atoms/featureCreditRuns';
import { isUsingBeaverCreditsAtom } from '../../atoms/models';
import { currentMessageContentAtom, currentMessagePillsAtom, pendingPillInsertsAtom } from '../../atoms/messageComposition';
import { hasTextBesidesPills } from '../../utils/actionRequirements';
import { searchableLibraryIdsAtom } from '../../atoms/profile';
import { examplesForLibrary, getFeatureCreditTask, promptSection, type FeatureTaskDefinition, type LibraryShape } from '../../constants/featureCreditTasks';
import { attachmentsSetScope, featureTaskModelNote, setupSource } from '../../utils/featureCredits';
import { countLibraryItems, readLibraryShape } from '../../utils/libraryShape';
import { SMALL_LIBRARY_THRESHOLD } from '../../atoms/zoteroContext';

const TASK_ICONS: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
    literature_review: QuillWriteIcon,
    annotate: HighlighterIcon,
    organize: LayersIcon,
    research_table: TableIcon,
};

/** One task in the list: done, or a button that opens its setup card. */
const TaskRow: React.FC<{ entry: FeatureCreditEntry; onStart: (key: string, win: Window | null) => void }> = ({ entry, onStart }) => {
    const { task, definition } = entry;
    const done = !!task.completed_at;
    const body = (
        <>
            <Icon
                icon={done ? CheckmarkCircleSolidIcon : (TASK_ICONS[definition.key] ?? CircleIcon)}
                className={`feature-credits-row-mark scale-11 ${done ? 'font-color-green' : 'font-color-secondary'}`}
                aria-label={done ? 'Done' : undefined}
            />
            <span className="feature-credits-row-text">
                <span className={done ? 'font-color-secondary' : 'font-color-primary font-medium'}>{definition.title}</span>
                <span className="feature-credits-row-subtitle">{definition.subtitle}</span>
            </span>
            {/* {!done && <span className="feature-credits-row-credits">+{task.credits}</span>} */}
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

/**
 * One step of a setup card. `done` shows a check, `active` (the step to act
 * on next) an accented number, `checking` a spinner; otherwise a plain number.
 */
type StepStatus = 'done' | 'active' | 'checking' | 'pending';

interface SetupStep {
    key: string;
    title: string;
    optional?: boolean;
    status: StepStatus;
    /** Required before sending: an active candidate until done. */
    required: boolean;
    body: React.ReactNode;
}

const StepMarker: React.FC<{ status: StepStatus; number: number }> = ({ status, number }) => (
    <span className={`feature-credits-step-marker is-${status}`} aria-hidden="true">
        {status === 'done' ? <Icon icon={TickIcon} className="scale-11" />
            : status === 'checking' ? <Spinner size={12} />
            : number}
    </span>
);

/**
 * The setup card, the same for every task: numbered steps (what Beaver works
 * on, what it should do) that turn into checks as they are done, then one
 * line on the reward. The first open required step is accented.
 */
const SetupView: React.FC<{ definition: FeatureTaskDefinition; credits: number; onBack: () => void }> = ({ definition, credits, onBack }) => {
    const summary = useAtomValue(featureTaskAttachmentSummaryAtom);
    const startTask = useSetAtom(startFeatureTaskAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const onBeaverModel = useAtomValue(isUsingBeaverCreditsAtom);
    const selectBeaverModel = useSetAtom(selectBeaverModelAtom);
    const content = useAtomValue(currentMessageContentAtom);
    const pills = useAtomValue(currentMessagePillsAtom);
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

    // Wording and examples that assume the attached papers are the scope.
    const attached = attachmentsSetScope(summary);
    const source = setupSource(definition.attach, summary);
    const prompt = promptSection(definition.prompt, attached);
    const examples = examplesForLibrary(definition, shape, attached);
    const modelNote = featureTaskModelNote(definition.key, onBeaverModel);
    const hasInstruction = hasTextBesidesPills(content, pills);

    const beaverModelLink = (label: string) => (
        <a href="#" className="feature-credits-link" onClick={(event) => { event.preventDefault(); selectBeaverModel(); }}>
            {label}
        </a>
    );
    const applyExample = (text: string, event: React.MouseEvent<HTMLElement>) => {
        event.preventDefault();
        startTask({ key: definition.key, targetWindow: event.currentTarget.ownerDocument.defaultView ?? undefined, argumentText: text });
    };

    const steps: SetupStep[] = [];
    if (modelNote?.required) {
        steps.push({
            key: 'model',
            title: 'Use the Beaver model',
            status: 'pending',
            required: true,
            body: <>{modelNote.text} {beaverModelLink('Switch to it')}</>,
        });
    }
    steps.push({
        key: 'source',
        title: source.title,
        optional: source.optional,
        status: source.state === 'ready' ? 'done' : source.state === 'checking' ? 'checking' : 'pending',
        required: source.state === 'missing' || source.state === 'checking',
        body: source.text,
    });
    steps.push({
        key: 'prompt',
        title: prompt.heading,
        optional: prompt.optional,
        status: hasInstruction ? 'done' : 'pending',
        required: !prompt.optional,
        body: (
            <>
                {prompt.hint}
                {examples.length > 0 && (
                    <ul className="feature-credits-examples" aria-label="Examples">
                        {examples.map((example) => (
                            <li key={example.text}>
                                <button
                                    type="button"
                                    className="feature-credits-example"
                                    onClick={(event) => applyExample(example.text, event)}
                                >
                                    {example.text}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </>
        ),
    });
    // The step to act on next: the first required one not yet done.
    const next = steps.find((step) => step.required && step.status === 'pending');
    if (next) next.status = 'active';

    return (
        <>
            <div className="feature-credits-header">
                <IconButton icon={ArrowLeftIcon} variant="ghost-secondary" ariaLabel="Back to all tasks" onClick={onBack} />
                <h2 className="feature-credits-title">{definition.title}</h2>
            </div>
            <ol className="feature-credits-steps">
                {steps.map((step, index) => (
                    <li key={step.key} className={`feature-credits-step is-${step.status}`}>
                        <StepMarker status={step.status} number={index + 1} />
                        <div className="feature-credits-step-body">
                            <h3 className="feature-credits-step-title">
                                {step.status === 'done' && <span className="sr-only">Done: </span>}
                                {step.title}
                                {step.optional && <span className="feature-credits-step-optional"> (optional)</span>}
                            </h3>
                            <div className="feature-credits-step-text">{step.body}</div>
                        </div>
                    </li>
                ))}
            </ol>
            <p className="feature-credits-reward">
                Send your prompt to earn {credits} free credits.
                {definition.footnote && <> {definition.footnote}</>}
                {modelNote && !modelNote.required && <> {modelNote.text} {beaverModelLink('Use it')}</>}
            </p>
        </>
    );
};

/** The last library-size check, so a return to home does not wait for it. */
let lastLibraryCheck: { libraries: string; ready: boolean } | null = null;

/**
 * "Try Beaver and earn free credits": the feature-credit tasks on the home screen.
 *
 * The list shows each skill; clicking an open one stages its action in the
 * chat input and swaps the list for that task's setup card. The setup ends
 * when the user goes back or removes the /command from the chat input.
 */
const FeatureCreditsCard: React.FC<{
    /** Whether the card is on screen; home hides recent chats while it is. */
    onShownChange?: (shown: boolean) => void;
}> = ({ onShownChange }) => {
    const entries = useAtomValue(featureCreditEntriesAtom);
    const [activeKey, setActiveKey] = useAtom(activeFeatureTaskAtom);
    const setDismissed = useSetAtom(featureCreditsCardDismissedAtom);
    const startTask = useSetAtom(startFeatureTaskAtom);
    const pills = useAtomValue(currentMessagePillsAtom);
    const pendingPills = useAtomValue(pendingPillInsertsAtom);

    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    // The tasks need papers to work on: the list waits for a library of a
    // useful size (the threshold first run uses). Checked when the card
    // mounts, so papers added since show it on the next visit to home.
    const librariesKey = searchableLibraryIds.join(',');
    const [libraryReady, setLibraryReady] = useState<boolean | null>(
        () => (lastLibraryCheck?.libraries === librariesKey ? lastLibraryCheck.ready : null),
    );
    useEffect(() => {
        let cancelled = false;
        void countLibraryItems(SMALL_LIBRARY_THRESHOLD, searchableLibraryIds).then((count) => {
            const ready = count !== null && count >= SMALL_LIBRARY_THRESHOLD;
            lastLibraryCheck = { libraries: searchableLibraryIds.join(','), ready };
            if (!cancelled) setLibraryReady(ready);
        });
        return () => {
            cancelled = true;
        };
    }, [searchableLibraryIds]);

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
    // A setup someone asked for (Next, Plan & Usage) shows whatever the library size.
    const shown = !!entries && (showSetup || libraryReady === true);
    useEffect(() => {
        if (shown) Zotero.Beaver?.account?.markFeatureCreditsCardSeen();
    }, [shown]);
    const visible = !!entries && shown;
    useEffect(() => {
        onShownChange?.(visible);
    }, [visible, onShownChange]);
    useEffect(() => () => onShownChange?.(false), [onShownChange]);

    if (!entries || !shown) return null;

    const onStart = (key: string, win: Window | null) => {
        pillSeenRef.current = false;
        startTask({ key, targetWindow: win ?? undefined });
    };

    if (showSetup && activeEntry && activeDefinition) {
        return (
            <section className="feature-credits-card" aria-label={`${activeDefinition.title}: how to start`}>
                <SetupView definition={activeDefinition} credits={activeEntry.task.credits} onBack={() => setActiveKey(null)} />
            </section>
        );
    }

    return (
        <section className="feature-credits-card" aria-labelledby="feature-credits-title">
            <div className="feature-credits-header">
                <h2 id="feature-credits-title" className="feature-credits-title">Try Beaver and earn free credits</h2>
                <IconButton icon={CancelIcon} variant="ghost-secondary" ariaLabel="Dismiss" onClick={() => setDismissed(true)} />
            </div>
            <p className="feature-credits-text">
                Choose a task below. You'll earn credits the first time you send it.
            </p>
            <ul className="feature-credits-list">
                {entries.map((entry) => (
                    <TaskRow key={entry.definition.key} entry={entry} onStart={onStart} />
                ))}
            </ul>
        </section>
    );
};

export default FeatureCreditsCard;
