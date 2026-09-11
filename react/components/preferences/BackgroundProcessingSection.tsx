import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { hasOcrAccessAtom, hasSearchIndexAccessAtom } from '../../atoms/profile';
import {
    backgroundProcessingStatusAtom,
    type BackgroundProcessingStatus,
} from '../../atoms/backgroundProcessing';
import {
    embeddingIndexStateAtom,
    forceReindexAtom,
    isEmbeddingIndexingAtom,
    type EmbeddingIndexState,
} from '../../atoms/embeddingIndex';
import { useBackgroundProcessingStatus } from '../../hooks/useBackgroundProcessingStatus';
import { getPref, setPref } from '../../../src/utils/prefs';
import type { AttachmentRef, ProcessingIssueReason } from '../../../src/services/backgroundProcessing/issues';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import Button from '@beaver/agent-ui/primitives/Button';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { SettingsGroup, SettingsRow, SectionLabel } from './components/SettingsElements';
import ProcessingIssueGroupRow from './ProcessingIssueList';
import { ProgressBar } from '../status/ProgressBar';
import { describeStatus, plural, type StatusTone } from './processingStatusSentence';
import PlayIcon from '@beaver/agent-ui/icons/PlayIcon';
import StopIcon from '@beaver/agent-ui/icons/StopIcon';
import { prepareUncachedFiles } from '../../../src/services/backgroundProcessing/cachePreparation';

const TONE_COLOR: Record<StatusTone, string> = {
    idle: 'var(--accent-green)',
    busy: 'var(--accent-blue)',
    waiting: 'var(--tag-yellow)',
    error: 'var(--tag-red)',
};

/** Background worker activity: one headline, a reason, and the one action that applies. */
const ProcessingStatusRow: React.FC<{
    status: BackgroundProcessingStatus;
    canRestoreCache: boolean;
    /** The clicked action is still preparing work; the button waits for it. */
    processing: boolean;
    onProcessNow: (action: 'start' | 'rebuild') => void;
    onStopDrain: () => void;
}> = ({ status, canRestoreCache, processing, onProcessNow, onStopDrain }) => {
    const sentence = describeStatus(status, { canRestoreCache });
    // Progress through the current run, from how the queue depth moves between
    // polls: a drop is work completed, a rise is work added (the reconciler
    // keeps queueing new files during a run), so `total - done` always equals
    // the depth shown in the caption. A poll that nets the two against each
    // other under-reports both, which only delays the bar. Forgotten once the
    // lane settles, so the next run starts its own bar. Updating the ref
    // during render is safe: a repeated render sees a zero delta.
    const run = useRef<{ seen: number; done: number; total: number } | null>(null);
    if (sentence.outstanding === undefined) {
        run.current = null;
    } else if (run.current === null) {
        run.current = { seen: sentence.outstanding, done: 0, total: sentence.outstanding };
    } else {
        const delta = sentence.outstanding - run.current.seen;
        if (delta < 0) run.current.done -= delta;
        else run.current.total += delta;
        run.current.seen = sentence.outstanding;
    }
    const progress = run.current && run.current.total > 0 ? run.current : null;

    return (
        <div className="display-flex flex-col gap-1 border-top-quinary" style={{ padding: '10px 12px 12px' }}>
            <div className="display-flex flex-row items-center gap-3">
                <div className="display-flex flex-row items-start gap-2 flex-1 min-w-0">
                    <div
                        className="display-flex items-center justify-center flex-shrink-0"
                        style={{ width: '14px', height: '1.25em' }}
                    >
                        {sentence.tone === 'busy'
                            ? <Spinner size={14} className="font-color-accent-blue" />
                            : <span
                                aria-hidden="true"
                                style={{ width: '10px', height: '10px', borderRadius: '50%', background: TONE_COLOR[sentence.tone] }}
                            />
                        }
                    </div>
                    <div className="display-flex flex-col gap-05 min-w-0 flex-1">
                        <div
                            role="status"
                            className={`text-base font-medium ${sentence.tone === 'error' ? 'font-color-red' : 'font-color-primary'}`}
                        >
                            {sentence.headline}
                        </div>
                        <div className="text-base font-color-secondary">
                            {sentence.caption}
                            {sentence.tone === 'error' && status.error && (
                                <span className="font-color-tertiary"> ({status.error})</span>
                            )}
                        </div>
                    </div>
                </div>
                {sentence.stopDrain ? (
                    <Tooltip
                        content="The current file finishes first. Processing then waits until Zotero is idle."
                        placement="top"
                    >
                        <Button
                            variant="outline"
                            className="flex-shrink-0"
                            rightIcon={StopIcon}
                            onClick={onStopDrain}
                        >
                            Stop
                        </Button>
                    </Tooltip>
                ) : sentence.processNow || sentence.rebuildCache ? (
                    <Tooltip
                        content={sentence.caption}
                        disabled={!sentence.processNowBlocked}
                        placement="top"
                    >
                        <Button
                            variant="outline"
                            className="flex-shrink-0"
                            rightIcon={PlayIcon}
                            disabled={sentence.processNowBlocked || processing}
                            loading={processing}
                            ariaLabel={sentence.processNowBlocked
                                ? `Start now. ${sentence.caption}`
                                : undefined}
                            onClick={() => onProcessNow(sentence.rebuildCache ? 'rebuild' : 'start')}
                        >
                            {sentence.rebuildCache ? 'Rebuild cache' : 'Start now'}
                        </Button>
                    </Tooltip>
                ) : null}
            </div>
            {progress && (
                <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={progress.total}
                    aria-valuenow={progress.done}
                    aria-label={`${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} files processed in this run`}
                    className="display-flex flex-row items-start gap-3"
                    style={{ paddingLeft: '22px' }}
                >
                    <div className="flex-1 min-w-0">
                        <ProgressBar progress={Math.floor((progress.done / progress.total) * 100)} />
                    </div>
                    <span className="text-sm font-color-secondary flex-shrink-0" aria-hidden="true">
                        {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
                    </span>
                </div>
            )}
        </div>
    );
};

/**
 * The server search-index check, for accounts with full-text search. Shown
 * with the toggle so it stays visible while processing is paused. The status
 * poll keeps the last successful check when a later one fails, so a failure
 * is named ahead of that stale result rather than hidden behind it.
 */
function searchIndexStatusLine(status: BackgroundProcessingStatus): string {
    const known = status.coverage
        ? (status.coverage.namespace_exists
            ? 'Full-text search index available.'
            : 'Full-text search index not built yet.')
        : null;
    const checked = known && status.coverageUpdatedAt
        ? ` Last checked ${new Date(status.coverageUpdatedAt).toLocaleString()}.`
        : '';
    if (status.coverageError) {
        return 'The full-text search index could not be checked.'
            + (known ? ` Last known status: ${known}${checked}` : '');
    }
    return known ? known + checked : 'Checking the full-text search index…';
}

/** True while the local metadata search index has something to fix. */
function hasMetadataIndexProblem(indexState: EmbeddingIndexState): boolean {
    return indexState.failedItems > 0 || (indexState.status === 'error' && Boolean(indexState.error));
}

/**
 * Items the local metadata search index could not embed. The index maintains
 * itself, so this row appears only while there is something to fix.
 */
const MetadataIndexProblemRow: React.FC<{ indexState: EmbeddingIndexState }> = ({ indexState }) => {
    const isIndexing = useAtomValue(isEmbeddingIndexingAtom);
    const forceReindex = useSetAtom(forceReindexAtom);
    const failed = indexState.failedItems > 0;
    const errored = indexState.status === 'error' && Boolean(indexState.error);
    if (!failed && !errored) return null;
    return (
        <SettingsRow
            hasBorder
            announceDescription
            title={failed
                ? `${plural(indexState.failedItems, 'item')} missing from metadata search`
                : 'Metadata search index needs attention'}
            description={errored
                ? `The last index update failed: ${indexState.error}`
                : 'These items could not be added to the local index that powers searching by title and abstract.'}
            control={
                <Button
                    variant="outline"
                    onClick={() => { if (!isIndexing) forceReindex(); }}
                    disabled={isIndexing}
                    loading={isIndexing}
                >
                    {isIndexing ? 'Rebuilding…' : 'Rebuild'}
                </Button>
            }
        />
    );
};

export default function BackgroundProcessingSection(): React.ReactElement | null {
    const hasOcrAccess = useAtomValue(hasOcrAccessAtom);
    const hasSearchAccess = useAtomValue(hasSearchIndexAccessAtom);
    const status = useAtomValue(backgroundProcessingStatusAtom);
    const indexState = useAtomValue(embeddingIndexStateAtom);
    const [enabled, setEnabled] = useState(
        () => getPref('backgroundProcessingEnabled') === true,
    );
    const working = (status.worker?.inFlight ?? 0) > 0 || status.worker?.drainNow === true;
    const refresh = useBackgroundProcessingStatus({
        includeCoverage: hasSearchAccess,
        includeFailures: true,
        // Poll faster while files are being processed so the bar keeps up.
        pollIntervalMs: working ? 4_000 : 15_000,
    });

    useEffect(() => {
        let observer: symbol | null = null;
        try {
            observer = Zotero.Prefs.registerObserver(
                'extensions.zotero.beaver.backgroundProcessingEnabled',
                () => setEnabled(getPref('backgroundProcessingEnabled') === true),
                true,
            );
        } catch { /* preferences may be closing */ }
        return () => {
            if (observer === null) return;
            try { Zotero.Prefs.unregisterObserver(observer); } catch { /* best effort */ }
        };
    }, []);

    const updateEnabled = (next: boolean) => {
        setEnabled(next);
        setPref('backgroundProcessingEnabled', next);
        if (!next) Zotero.Beaver?.backgroundExtractor?.cancelImmediateDrain();
        Zotero.Beaver?.processingReconciler?.notify();
        Zotero.Beaver?.backgroundExtractor?.notify();
    };

    const [actionError, setActionError] = useState<string | null>(null);
    const canRestoreCache = enabled && status.documentCache?.can_prepare_uncached_files === true;

    /** Start pending work or explicitly rebuild cached text, according to the clicked action. */
    const [processing, setProcessing] = useState(false);
    const processNow = async (action: 'start' | 'rebuild') => {
        if (processing) return;
        setProcessing(true);
        setActionError(null);
        const report = (error: unknown) => setActionError((current) =>
            current ?? (error instanceof Error ? error.message : 'Could not start processing.'));
        try {
            if (action === 'rebuild') {
                await prepareUncachedFiles().catch(report);
            } else {
                await Zotero.Beaver?.processingReconciler?.reconcileNow().catch(report);
            }
            Zotero.Beaver?.backgroundExtractor?.requestImmediateDrain();
            await refresh();
        } finally {
            setProcessing(false);
        }
    };

    const stopDrain = async () => {
        Zotero.Beaver?.backgroundExtractor?.cancelImmediateDrain();
        await refresh();
    };

    /**
     * Requeue attachments from an issue group; `refs === null` retries the
     * whole group. The reconciler resets the failed stage and drains at once,
     * so the refreshed status shows the files running rather than listed.
     */
    const retryIssues = async (reason: ProcessingIssueReason, refs: AttachmentRef[] | null) => {
        const reconciler = Zotero.Beaver?.processingReconciler;
        const db = Zotero.Beaver?.db;
        if (!reconciler || !db) return;
        setActionError(null);
        try {
            const targets = refs ?? await db.getProcessingIssueRefs(
                { hasOcrAccess, hasSearchIndexAccess: hasSearchAccess }, reason,
            );
            if (targets.length > 0) await reconciler.retryAttachments(targets);
        } catch (error) {
            setActionError(error instanceof Error ? error.message : 'Could not retry these files.');
        }
        await refresh();
    };

    const issueCount = status.issues.reduce((sum, group) => sum + group.count, 0);
    const metadataProblem = hasMetadataIndexProblem(indexState);
    const problemsSummary: React.ReactNode = status.error
        ? 'Could not update the list of problems. Previously reported problems are shown below.'
        : status.updatedAt === null
            ? metadataProblem ? 'Checking files for problems…' : 'Checking for problems…'
            : issueCount > 0
                ? <>
                    Of the files Beaver has processed so far,{' '}
                    <span className="font-medium font-color-primary">{plural(issueCount, 'attachment')}</span>
                    {' '}could not be read or indexed.
                </>
                : metadataProblem
                    ? 'All files Beaver has processed so far were read. Metadata search needs attention.'
                    : 'No problems found in the files Beaver has processed so far.';

    return (
        <>
            <SectionLabel>Background Processing</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title={hasSearchAccess ? 'Keep Full-Text Search Up to Date' : 'Process Files in the Background'}
                    announceDescription={hasSearchAccess}
                    description={hasSearchAccess
                        ? <>
                            Background processing keeps full-text search up to date. Turn it off to pause updates; existing search results are retained.
                            <span className="display-flex mt-1">
                                {!enabled && 'Updates paused. '}{searchIndexStatusLine(status)}
                            </span>
                        </>
                        : 'By default, Beaver processes files when you use them. Turn this on to process files ahead of time, while Zotero is idle, for faster responses.'}
                    onClick={() => updateEnabled(!enabled)}
                    control={<input
                        type="checkbox"
                        aria-label={hasSearchAccess ? 'Keep full-text search up to date' : 'Process files in the background'}
                        checked={enabled}
                        onChange={(event) => updateEnabled(event.target.checked)}
                        onClick={(event) => event.stopPropagation()}
                    />}
                />
                {(enabled || (status.worker?.inFlight ?? 0) > 0) && (
                    <ProcessingStatusRow
                        status={status}
                        canRestoreCache={canRestoreCache}
                        processing={processing}
                        onProcessNow={processNow}
                        onStopDrain={stopDrain}
                    />
                )}
                {actionError && <div role="alert" className="font-color-red text-base border-top-quinary" style={{ padding: '8px 12px' }}>{actionError}</div>}
            </SettingsGroup>

            <SectionLabel>Problems</SectionLabel>
            <SettingsGroup>
                <div className="font-color-secondary text-base" style={{ padding: '8px 12px' }}>
                    {problemsSummary}
                </div>
                {status.issues.map((group) => (
                    <ProcessingIssueGroupRow
                        key={group.reason}
                        group={group}
                        hasOcrAccess={hasOcrAccess}
                        hasSearchAccess={hasSearchAccess}
                        issuesUpdatedAt={status.issuesUpdatedAt}
                        hasBorder
                        onRetry={retryIssues}
                    />
                ))}
                <MetadataIndexProblemRow indexState={indexState} />
            </SettingsGroup>
        </>
    );
}
