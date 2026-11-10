import React, { useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { getHost } from '@beaver/agent-ui/host';
import { chatFillsAtom } from '@beaver/agent-core/run-state/tableChatFills';
import type { FeatureCreditPopupData } from '../../types/popupMessage';
import { ArrowRightIcon, ArrowUpRightIcon, CancelIcon, CheckmarkCircleSolidIcon, Icon } from '../icons/icons';
import { featureCreditEntriesAtom, featureCreditTotalsAtom, startFeatureTaskAtom } from '../../atoms/featureCredits';
import { threadAgentActionsAtom } from '../../agents/agentActions';
import { newThreadAtom } from '../../atoms/threads';
import { stageActionPillAtom } from '../../atoms/actions';
import { addPopupMessageAtom } from '../../utils/popupMessageUtils';
import { getFeatureCreditTask } from '../../constants/featureCreditTasks';
import { buildFeatureCreditResult, type FeatureCreditResultTarget } from './featureCreditResult';
import { openSource, revealSource } from '../../utils/sourceUtils';
import { libraryRefForLibraryID } from '../../../src/utils/libraryIdentity';
import { exportNoteToFile, openExportedFile, revealExportedFile } from '../../host/zotero/fileExport';
import { exportWithFeedback } from '../../utils/fileExportFeedback';

interface Props {
    data: FeatureCreditPopupData;
    onDismiss: () => void;
}

/**
 * The card a window shows once a feature-credit task is earned in its chat:
 * the reward, what Beaver did, what else the skill can do, and the next task.
 * It stays until closed.
 */
const FeatureCreditCompletionContent: React.FC<Props> = ({ data, onDismiss }) => {
    const definition = getFeatureCreditTask(data.key);
    const entries = useAtomValue(featureCreditEntriesAtom) ?? [];
    const totals = useAtomValue(featureCreditTotalsAtom);
    const threadActions = useAtomValue(threadAgentActionsAtom);
    const fills = useAtomValue(chatFillsAtom);
    const startTask = useSetAtom(startFeatureTaskAtom);
    const stageActionPill = useSetAtom(stageActionPillAtom);
    const newThread = useSetAtom(newThreadAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);

    const result = useMemo(
        () => buildFeatureCreditResult(data.key, data.source, threadActions),
        [data.key, data.source, threadActions],
    );

    if (!definition) return null;

    const position = entries.findIndex((entry) => entry.definition.key === data.key);
    const next = entries.find((entry) => !entry.task.completed_at && entry.definition.key !== data.key);
    const allDone = totals.count > 0 && totals.done === totals.count;

    // This window's snapshot of the fill, else the plugin's record of it,
    // which every window shares while the finished fill is kept.
    const tableOfFill = (jobId: string) =>
        fills.get(jobId)?.snapshot.table ?? Zotero.Beaver?.tableFills?.getJob(jobId)?.table ?? null;

    const windowOf = (event: React.SyntheticEvent) => event.currentTarget.ownerDocument?.defaultView ?? undefined;

    const openResult = async (target: FeatureCreditResultTarget, event: React.SyntheticEvent) => {
        if (target.kind === 'open_item') await openSource(target.ref);
        else if (target.kind === 'reveal_item') revealSource(target.ref);
        else {
            const table = tableOfFill(target.jobId);
            const libraryRef = table ? libraryRefForLibraryID(table.libraryID) : null;
            if (!table || !libraryRef) return;
            await getHost().navigation?.openTable?.(`${libraryRef}-${table.key}`, windowOf(event) ?? null).catch(() => undefined);
        }
    };

    const startInNewChat = async (event: React.MouseEvent, start: () => void) => {
        event.preventDefault();
        const win = windowOf(event);
        // Undefined when the user kept the current chat, or another
        // navigation superseded this one.
        if ((await newThread({ window: win })) === undefined) return;
        onDismiss();
        start();
    };

    const followUp = definition.completion.followUp;
    const onFollowUp = (event: React.MouseEvent) => {
        if (!followUp) return;
        if (followUp.exportNote && result?.note) {
            event.preventDefault();
            const note = result.note;
            void exportWithFeedback('docx', () => exportNoteToFile({ format: 'docx', surface: 'note_card', note }), addPopupMessage, {
                reveal: revealExportedFile,
                open: openExportedFile,
            });
            return;
        }
        if (followUp.actionId) {
            const actionId = followUp.actionId;
            const win = windowOf(event);
            void startInNewChat(event, () => stageActionPill({ actionId, targetWindow: win }));
        }
    };
    const showFollowUp = !!followUp && (!followUp.exportNote || !!result?.note);

    return (
        <div className="feature-credits-completion">
            <div className="feature-credits-header">
                <Icon icon={CheckmarkCircleSolidIcon} className="font-color-green flex-none" />
                <h2 className="feature-credits-title">
                    +{data.credits} credits · {definition.title}
                </h2>
                {position >= 0 && totals.count > 0 && (
                    <span className="feature-credits-progress">{totals.done} of {totals.count}</span>
                )}
                <IconButton icon={CancelIcon} variant="ghost-secondary" ariaLabel="Close" onClick={onDismiss} />
            </div>

            {result && (
                <div className="feature-credits-result">
                    <span className="flex-1">{result.text}</span>
                    {result.target && (result.target.kind !== 'open_table' || !!tableOfFill(result.target.jobId)) && (
                        <Button
                            variant="outline"
                            rightIcon={ArrowUpRightIcon}
                            onClick={(event) => void openResult(result.target!, event)}
                            className="flex-none"
                        >
                            {result.target.label}
                        </Button>
                    )}
                </div>
            )}

            <p className="feature-credits-text">{definition.completion.more}</p>
            <p className="feature-credits-text">
                {showFollowUp && (
                    <>
                        <a href="#" className="text-link" onClick={onFollowUp}>{followUp!.label}</a>
                        {' · '}
                    </>
                )}
                <a
                    href={definition.completion.docsUrl}
                    className="text-link"
                    onClick={(event) => {
                        event.preventDefault();
                        Zotero.launchURL(definition.completion.docsUrl);
                    }}
                >
                    Learn more
                </a>
            </p>

            <div className="feature-credits-divider" />
            {allDone || !next ? (
                <p className="feature-credits-text font-medium">
                    All done. {totals.earned} credits earned.
                </p>
            ) : (
                <button
                    type="button"
                    className="feature-credits-next"
                    onClick={(event) => {
                        const key = next.definition.key;
                        const win = windowOf(event);
                        void startInNewChat(event, () => startTask({ key, targetWindow: win }));
                    }}
                >
                    <span className="flex-1">
                        Next: {next.definition.title} <span className="font-color-green">(+{next.task.credits})</span>
                    </span>
                    <Icon icon={ArrowRightIcon} className="font-color-tertiary" />
                </button>
            )}
        </div>
    );
};

export default FeatureCreditCompletionContent;
