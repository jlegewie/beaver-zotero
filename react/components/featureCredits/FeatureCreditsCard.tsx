import React, { useEffect, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { ArrowLeftIcon, ArrowRightIcon, CancelIcon, CheckmarkCircleSolidIcon, CircleIcon, Icon } from '../icons/icons';
import {
    activeFeatureTaskAtom,
    featureCreditEntriesAtom,
    featureCreditsCardDismissedAtom,
    featureTaskAttachmentSummaryAtom,
    startFeatureTaskAtom,
    type FeatureCreditEntry,
} from '../../atoms/featureCredits';
import { currentMessagePillsAtom, pendingPillInsertsAtom } from '../../atoms/messageComposition';
import { searchableLibraryIdsAtom } from '../../atoms/profile';
import { actionsAtom } from '../../atoms/actions';
import { getActionCommand } from '@beaver/agent-ui/composer/slashCommands';
import { examplesForLibrary, getFeatureCreditTask, type FeatureTaskDefinition, type LibraryShape } from '../../constants/featureCreditTasks';
import { attachStep, topicStatus, type AttachStep } from '../../utils/featureCredits';
import { readLibraryShape } from '../../utils/libraryShape';

/** One task in the list: done, or a button that opens its setup card. */
const TaskRow: React.FC<{ entry: FeatureCreditEntry; onStart: (key: string, win: Window | null) => void }> = ({ entry, onStart }) => {
    const { task, definition } = entry;
    const done = !!task.completed_at;
    const body = (
        <>
            <Icon
                icon={done ? CheckmarkCircleSolidIcon : CircleIcon}
                className={`feature-credits-row-mark ${done ? 'font-color-green' : 'font-color-quarternary'}`}
                aria-label={done ? 'Done' : undefined}
            />
            <span className="feature-credits-row-text">
                <span className={done ? 'font-color-secondary' : 'font-color-primary'}>{definition.title}</span>
                <span className="feature-credits-row-subtitle">{definition.subtitle}</span>
            </span>
            {!done && <Icon icon={ArrowRightIcon} className="feature-credits-row-arrow font-color-tertiary" />}
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

/** A step line: ✓ status, or a numbered instruction. */
const StepLine: React.FC<{ number: number; step: AttachStep }> = ({ number, step }) => (
    <li className="feature-credits-step">
        <span className={`feature-credits-step-marker ${step.done ? 'font-color-green' : ''}`} aria-hidden="true">
            {step.done ? '✓' : `${number}.`}
        </span>
        <span>
            <strong className="font-medium">{step.lead}</strong> {step.text}
        </span>
    </li>
);

/** The setup card: what the skill does and how to start it in the chat input. */
const SetupView: React.FC<{ definition: FeatureTaskDefinition; credits: number; onBack: () => void }> = ({ definition, credits, onBack }) => {
    const summary = useAtomValue(featureTaskAttachmentSummaryAtom);
    const startTask = useSetAtom(startFeatureTaskAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
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

    // The command as the user knows it: built-ins can be renamed.
    const action = useAtomValue(actionsAtom).find((candidate) => candidate.id === definition.actionId);
    const command = `/${action ? getActionCommand(action) : definition.actionId.replace(/^builtin-/, '')}`;
    const step1 = attachStep(definition.attach, summary);
    const status = definition.attach.kind === 'topic' ? topicStatus(summary) : null;
    const examples = examplesForLibrary(definition, shape);
    const instructionNumber = step1 ? 2 : 1;

    const applyExample = (text: string, event: React.MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        startTask({ key: definition.key, targetWindow: event.currentTarget.ownerDocument.defaultView ?? undefined, argumentText: text });
    };

    return (
        <>
            <div className="feature-credits-header">
                <IconButton icon={ArrowLeftIcon} variant="ghost-secondary" ariaLabel="Back to all tasks" onClick={onBack} />
                <h2 className="feature-credits-title">{definition.title}</h2>
            </div>
            <p className="feature-credits-text">{definition.explanation}</p>
            {status && (
                <p className="feature-credits-text">
                    <span className="font-color-green" aria-hidden="true">✓ </span>
                    <strong className="font-medium">{status.lead}</strong> {status.text}
                </p>
            )}
            <ol className="feature-credits-steps">
                {step1 && <StepLine number={1} step={step1} />}
                <li className="feature-credits-step">
                    <span className="feature-credits-step-marker" aria-hidden="true">{instructionNumber}.</span>
                    <span>
                        After <span className="feature-credits-command">{command}</span>, {definition.instruction}. For example:{' '}
                        {examples.map((example, index) => (
                            <React.Fragment key={example.text}>
                                {index > 0 && ' · '}
                                <a href="#" className="text-link" onClick={(event) => applyExample(example.text, event)}>
                                    {example.text}
                                </a>
                            </React.Fragment>
                        ))}
                    </span>
                </li>
                <li className="feature-credits-step">
                    <span className="feature-credits-step-marker" aria-hidden="true">{instructionNumber + 1}.</span>
                    <span>
                        {definition.finalStep} <strong className="font-medium font-color-green">+{credits} credits</strong>
                    </span>
                </li>
            </ol>
            {definition.footnote && <p className="feature-credits-text font-color-tertiary">{definition.footnote}</p>}
        </>
    );
};

/**
 * "Get more out of Beaver": the feature-credit tasks on the home screen.
 *
 * The list shows each skill; clicking an open one stages its action in the
 * chat input and swaps the list for that task's setup card. The setup ends
 * when the user goes back or removes the /command from the chat input.
 */
const FeatureCreditsCard: React.FC = () => {
    const entries = useAtomValue(featureCreditEntriesAtom);
    const [activeKey, setActiveKey] = useAtom(activeFeatureTaskAtom);
    const setDismissed = useSetAtom(featureCreditsCardDismissedAtom);
    const startTask = useSetAtom(startFeatureTaskAtom);
    const pills = useAtomValue(currentMessagePillsAtom);
    const pendingPills = useAtomValue(pendingPillInsertsAtom);

    // Ask the server to catch up on anything earned since the last check.
    useEffect(() => {
        Zotero.Beaver?.account?.syncFeatureCredits({ catchUp: true });
    }, []);

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

    if (!entries) return null;

    const onStart = (key: string, win: Window | null) => {
        pillSeenRef.current = false;
        startTask({ key, targetWindow: win ?? undefined });
    };

    if (activeEntry && activeDefinition && !activeEntry.task.completed_at) {
        return (
            <section className="feature-credits-card" aria-label={`${activeDefinition.title}: how to start`}>
                <SetupView
                    definition={activeDefinition}
                    credits={activeEntry.task.credits}
                    onBack={() => setActiveKey(null)}
                />
            </section>
        );
    }

    const perTask = new Set(entries.map(({ task }) => task.credits));
    const rewardText = perTask.size === 1
        ? `Each earns ${[...perTask][0]} free credits once you accept Beaver's changes.`
        : "Each earns free credits once you accept Beaver's changes.";

    return (
        <section className="feature-credits-card" aria-labelledby="feature-credits-title">
            <div className="feature-credits-header">
                <h2 id="feature-credits-title" className="feature-credits-title">Get more out of Beaver</h2>
                <IconButton icon={CancelIcon} variant="ghost-secondary" ariaLabel="Dismiss" onClick={() => setDismissed(true)} />
            </div>
            <p className="feature-credits-text">
                Learn {entries.length === 4 ? 'four' : entries.length} skills. {rewardText}
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
