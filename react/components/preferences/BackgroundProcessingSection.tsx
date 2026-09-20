import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { cloudConsentAtom, hasOcrAccessAtom, hasSearchIndexAccessAtom } from '../../atoms/profile';
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
import { ExternalLink, SettingsGroup, SettingsRow, SectionLabel } from './components/SettingsElements';
import ProcessingIssueGroupRow from './ProcessingIssueList';
import { ProgressBar } from '../status/ProgressBar';
import { describeStatus, plural, type StatusSentence, type StatusTone } from './processingStatusSentence';
import PlayIcon from '@beaver/agent-ui/icons/PlayIcon';
import StopIcon from '@beaver/agent-ui/icons/StopIcon';
import { prepareUncachedFiles } from '../../../src/services/backgroundProcessing/cachePreparation';

const TONE_COLOR: Record<StatusTone, string> = {
    idle: 'var(--accent-green)',
    busy: 'var(--accent-blue)',
    waiting: 'var(--tag-yellow)',
    error: 'var(--tag-red)',
};

/** Activity and its explanation, followed by progress and cumulative file problems. */
const ProcessingStatusRow: React.FC<{
    status: BackgroundProcessingStatus;
    sentence: StatusSentence;
    /** The clicked action is still preparing work; the button waits for it. */
    processing: boolean;
    onProcessNow: () => void;
    onStopDrain: () => void;
    onShowProblems: () => void;
    /** The last server search-index check failed. */
    searchIndexUnavailable: boolean;
}> = ({
    status, sentence, processing, onProcessNow, onStopDrain, onShowProblems, searchIndexUnavailable,
}) => {
    const run = status.progress;
    const issueCount = status.issues.reduce((sum, group) => sum + group.count, 0);
    const indexIssueCount = status.issues.find((group) => group.reason === 'index_failed')?.count ?? 0;
    const readingIssueCount = issueCount - indexIssueCount;
    // One line for every kind of problem; the Problems section directly below
    // breaks them down by reason.
    const problemVerb = indexIssueCount > 0 && readingIssueCount > 0
        ? 'read or indexed'
        : indexIssueCount > 0 ? 'indexed' : 'read';
    const progress = run && run.total > 0 && (run.pending > 0 || (status.worker?.inFlight ?? 0) > 0) ? {
        total: run.total,
        done: run.succeeded + run.problems + run.removed,
    } : null;

    return (
        <div className="display-flex flex-col border-top-quinary" style={{ padding: '8px 12px 12px' }}>
            <div className="display-flex flex-row items-center gap-3" style={{ minHeight: '24px' }}>
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
                    <div
                        role="status"
                        className={`text-base font-medium flex-1 min-w-0 ${sentence.tone === 'error' ? 'font-color-red' : 'font-color-primary'}`}
                    >
                        {sentence.headline}
                    </div>
                </div>
                {sentence.stopDrain ? (
                    <Tooltip
                        content="The current file finishes first. Processing then waits until your computer is idle."
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
                ) : sentence.processNow ? (
                    <Tooltip
                        content={sentence.caption}
                        disabled={!sentence.processNowBlocked}
                        placement="top"
                    >
                        <Button
                            variant="outline"
                            className="flex-shrink-0"
                            rightIcon={PlayIcon}
                            disabled={sentence.processNowBlocked || processing || status.progress?.discovering}
                            loading={processing}
                            ariaLabel={sentence.processNowBlocked
                                ? `Start now. ${sentence.caption}`
                                : undefined}
                            onClick={onProcessNow}
                        >
                            Start now
                        </Button>
                    </Tooltip>
                ) : null}
            </div>
            <div className="text-base font-color-secondary" style={{ paddingLeft: '22px', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                {sentence.caption}
                {sentence.tone === 'error' && status.error && (
                    <span className="font-color-tertiary"> ({status.error})</span>
                )}
            </div>
            {progress && (
                <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={progress.total}
                    aria-valuenow={progress.done}
                    aria-label={`${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} attachments finished in this run`}
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
            {searchIndexUnavailable && <div className="text-sm font-color-secondary" style={{ paddingLeft: '22px' }}>
                The search index could not be checked. Beaver will try again.
            </div>}
            {issueCount > 0 && <div className="text-base font-color-secondary mt-2" style={{ paddingLeft: '22px' }}>
                {status.error ? 'Last reported: ' : ''}{plural(issueCount, 'file')} could not be {problemVerb}.{' '}
                <button type="button" className="text-link cursor-pointer" onClick={onShowProblems}
                    style={{ background: 'none', border: 'none', padding: 0, font: 'inherit' }}>
                    See Problems
                </button>
            </div>}
        </div>
    );
};

/**
 * Restores cached text that was evicted from the local document cache. The
 * cache is separate from the search index: eviction never removes a file from
 * search, and restoring only makes responses faster. Offered once processing
 * is settled, so the rebuild does not compete with pending work.
 */
const CachedTextRow: React.FC<{ processing: boolean; onRebuild: () => void }> = ({ processing, onRebuild }) => (
    <SettingsRow
        hasBorder
        announceDescription
        title="Cached text"
        description="Some processed files are no longer cached. Rebuilding prepares them again for faster responses."
        control={
            <Button
                variant="outline"
                rightIcon={PlayIcon}
                onClick={onRebuild}
                disabled={processing}
                loading={processing}
            >
                Rebuild cache
            </Button>
        }
    />
);

/**
 * Title and description of the setting, from what the account is entitled to.
 * A locked setting names only the features that lock it, so a user reads about
 * full-text search or OCR only when they have it.
 */
function describeSetting(
    hasSearchAccess: boolean,
    hasOcrAccess: boolean,
    locked: boolean,
): { title: string; description: string } {
    const title = hasSearchAccess ? 'Keep Full-Text Search Up to Date' : 'Process Files in the Background';
    if (!locked) {
        return { title, description: 'Process files ahead of time while your computer is idle for faster responses.' };
    }
    const features = [hasSearchAccess && 'full-text search', hasOcrAccess && 'OCR']
        .filter((feature): feature is string => Boolean(feature))
        .join(' and ');
    return {
        title,
        description: `Beaver reads new and changed files while your computer is idle. Required for ${features}.`,
    };
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
    const consent = useAtomValue(cloudConsentAtom);
    const hasOcrAccess = useAtomValue(hasOcrAccessAtom);
    const hasSearchAccess = useAtomValue(hasSearchIndexAccessAtom);
    const cloudRequired = hasOcrAccess || hasSearchAccess;
    const locked = cloudRequired && consent === 'accepted';
    const snapshot = useAtomValue(backgroundProcessingStatusAtom);
    // Entitlements may change before the next status snapshot arrives.
    const status = hasSearchAccess ? snapshot : {
        ...snapshot,
        issues: snapshot.issues.filter((group) => group.reason !== 'index_failed'),
    };
    const problemsHeading = useRef<HTMLSpanElement>(null);
    const showProblems = () => {
        problemsHeading.current?.scrollIntoView({ block: 'start' });
        problemsHeading.current?.focus({ preventScroll: true });
    };
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
        if (locked) return;
        setEnabled(next);
        setPref('backgroundProcessingEnabled', next);
        if (!next) Zotero.Beaver?.backgroundExtractor?.cancelImmediateDrain();
        Zotero.Beaver?.processingReconciler?.notify();
        Zotero.Beaver?.backgroundExtractor?.notify();
    };

    const [actionError, setActionError] = useState<string | null>(null);

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
            }
            // Starting the waiting queue must not force a library-wide source
            // recheck, which also retries settled availability failures.
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
    const indexIssueCount = status.issues.find((group) => group.reason === 'index_failed')?.count ?? 0;
    // The status poll keeps the last successful check when a later one fails,
    // so a failed check is reported rather than hidden behind the stale result.
    const searchIndexUnavailable = hasSearchAccess && status.coverageError !== null;
    const searchIndexUpToDate = hasSearchAccess
        && !searchIndexUnavailable
        && status.coverage?.namespace_exists === true
        && indexIssueCount === 0;
    const metadataProblem = hasMetadataIndexProblem(indexState);
    const setting = describeSetting(hasSearchAccess, hasOcrAccess, locked);
    const sentence = describeStatus(status, { searchIndexUpToDate });
    const showStatus = enabled || (status.worker?.inFlight ?? 0) > 0;
    const canRestoreCache = enabled
        && sentence.tone === 'idle'
        && status.documentCache?.can_prepare_uncached_files === true;
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
                    title={setting.title}
                    description={setting.description}
                    onClick={() => updateEnabled(!enabled)}
                    control={<input
                        type="checkbox"
                        aria-label={hasSearchAccess ? 'Keep full-text search up to date' : 'Process files in the background'}
                        disabled={locked}
                        checked={enabled}
                        onChange={(event) => updateEnabled(event.target.checked)}
                        onClick={(event) => event.stopPropagation()}
                    />}
                />
                {showStatus && (
                    <ProcessingStatusRow
                        status={status}
                        sentence={sentence}
                        processing={processing}
                        onProcessNow={() => processNow('start')}
                        onStopDrain={stopDrain}
                        onShowProblems={showProblems}
                        searchIndexUnavailable={searchIndexUnavailable}
                    />
                )}
                {canRestoreCache && (
                    <CachedTextRow processing={processing} onRebuild={() => processNow('rebuild')} />
                )}
                {actionError && <div role="alert" className="font-color-red text-base border-top-quinary" style={{ padding: '8px 12px' }}>{actionError}</div>}
            </SettingsGroup>

            <SectionLabel><span ref={problemsHeading} tabIndex={-1}>Problems</span></SectionLabel>
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
            <div className="text-sm font-color-secondary mt-2" style={{ paddingLeft: '4px' }}>
                Problems with a specific file? Send it to{' '}
                <ExternalLink href="mailto:contact@beaverapp.ai?subject=Beaver%20file%20problem" className="text-sm">
                    contact@beaverapp.ai
                </ExternalLink>
                {' '}and we will take a look.
            </div>
        </>
    );
}
