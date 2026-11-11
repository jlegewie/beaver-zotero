import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import type { FeatureCreditPopupData } from '../../types/popupMessage';
import { ArrowRightIcon, CancelIcon, CheckmarkCircleSolidIcon, Icon } from '../icons/icons';
import { featureCreditEntriesAtom, featureCreditTotalsAtom, startFeatureTaskAtom } from '../../atoms/featureCredits';
import { newThreadAtom } from '../../atoms/threads';
import { getFeatureCreditTask } from '../../constants/featureCreditTasks';

interface Props {
    data: FeatureCreditPopupData;
    onDismiss: () => void;
}

/**
 * The card a window shows once a feature-credit task is earned in its chat.
 * Every task has the same three parts: the reward and progress, one tip on
 * what else the skill can do, and the next task (or the total once all are
 * done). What Beaver did is already in the chat above. It stays until closed.
 */
const FeatureCreditCompletionContent: React.FC<Props> = ({ data, onDismiss }) => {
    const definition = getFeatureCreditTask(data.key);
    const entries = useAtomValue(featureCreditEntriesAtom) ?? [];
    const totals = useAtomValue(featureCreditTotalsAtom);
    const startTask = useSetAtom(startFeatureTaskAtom);
    const newThread = useSetAtom(newThreadAtom);

    if (!definition) return null;

    const next = entries.find((entry) => !entry.task.completed_at && entry.definition.key !== data.key);
    const { docsUrl, tip } = definition.completion;

    const startNext = async (event: React.MouseEvent<HTMLButtonElement>) => {
        if (!next) return;
        const key = next.definition.key;
        const win = event.currentTarget.ownerDocument?.defaultView ?? undefined;
        // Undefined when the user kept the current chat, or another
        // navigation superseded this one.
        if ((await newThread({ window: win })) === undefined) return;
        onDismiss();
        startTask({ key, targetWindow: win });
    };

    return (
        <div className="feature-credits-completion">
            <div className="feature-credits-header feature-credits-completion-header">
                <Icon icon={CheckmarkCircleSolidIcon} className="feature-credits-completion-mark font-color-green" />
                <div className="feature-credits-completion-heading">
                    <h2 className="feature-credits-title">You earned {data.credits} credits</h2>
                    <span className="feature-credits-completion-subtitle">
                        {definition.title}
                    </span>
                </div>
                <IconButton icon={CancelIcon} variant="ghost-secondary" ariaLabel="Close" onClick={onDismiss} />
            </div>

            <p className="feature-credits-text">
                {tip}{' '}
                <a
                    href={docsUrl}
                    className="feature-credits-link"
                    onClick={(event) => {
                        event.preventDefault();
                        Zotero.launchURL(docsUrl);
                    }}
                >
                    Learn more
                </a>
            </p>

            <div className="feature-credits-divider" />
            {next ? (
                <button type="button" className="feature-credits-next" onClick={(event) => void startNext(event)}>
                    <span className="flex-1">Next: {next.definition.title}</span>
                    <Icon icon={ArrowRightIcon} className="font-color-secondary" />
                </button>
            ) : (
                <p className="feature-credits-text">All done. You earned {totals.earned} credits.</p>
            )}
        </div>
    );
};

export default FeatureCreditCompletionContent;
