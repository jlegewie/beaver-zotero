import React, { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { hasOcrAccessAtom, hasSearchIndexAccessAtom } from '../../atoms/profile';
import {
    backgroundProcessingStatusAtom,
    type BackgroundProcessingStatus,
} from '../../atoms/backgroundProcessing';
import { useBackgroundProcessingStatus } from '../../hooks/useBackgroundProcessingStatus';
import { getPref, setPref } from '../../../src/utils/prefs';
import type { AttachmentRef, ProcessingIssueReason } from '../../../src/services/backgroundProcessing/issues';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import Button from '@beaver/agent-ui/primitives/Button';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { SettingsGroup, SettingsRow, SectionLabel } from './components/SettingsElements';
import ProcessingIssueGroupRow from './ProcessingIssueList';
import { describeStatus, plural, type StatusTone } from './processingStatusSentence';
import PlayIcon from '@beaver/agent-ui/icons/PlayIcon';
import StopIcon from '@beaver/agent-ui/icons/StopIcon';
import { clearDocumentCache } from '../../../src/services/backgroundProcessing/resetLocalState';

/** Format a byte count with one decimal in the largest fitting binary unit. */
function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

const TONE_COLOR: Record<StatusTone, string> = {
    idle: 'var(--accent-green)',
    busy: 'var(--accent-blue)',
    waiting: 'var(--tag-yellow)',
    error: 'var(--tag-red)',
};

/** Background worker activity, independent of cache occupancy and search coverage. */
const ProcessingStatusRow: React.FC<{
    status: BackgroundProcessingStatus;
    continuous: boolean;
    onProcessNow: () => void;
    onStopDrain: () => void;
}> = ({ status, continuous, onProcessNow, onStopDrain }) => {
    const sentence = describeStatus(status, continuous);

    return (
        <div className="display-flex flex-col gap-2 border-top-quinary" style={{ padding: '10px 12px 12px' }}>
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
                            disabled={sentence.processNowBlocked}
                            ariaLabel={sentence.processNowBlocked
                                ? `Process now. ${sentence.caption}`
                                : undefined}
                            onClick={onProcessNow}
                        >
                            Process now
                        </Button>
                    </Tooltip>
                ) : null}
            </div>


        </div>
    );
};

export default function BackgroundProcessingSection(): React.ReactElement | null {
    const hasOcrAccess = useAtomValue(hasOcrAccessAtom);
    const hasSearchAccess = useAtomValue(hasSearchIndexAccessAtom);
    const status = useAtomValue(backgroundProcessingStatusAtom);
    const [enabled, setEnabled] = useState(
        () => getPref('backgroundProcessingEnabled') === true,
    );
    const [continuous, setContinuous] = useState(
        () => getPref('backgroundProcessingContinuous') === true,
    );
    const working = (status.worker?.inFlight ?? 0) > 0 || status.worker?.drainNow === true;
    const refresh = useBackgroundProcessingStatus({
        includeCoverage: hasSearchAccess,
        includeFailures: true,
        // Poll faster while files are being processed so the bar keeps up.
        pollIntervalMs: working ? 4_000 : 15_000,
    });

    useEffect(() => {
        const observers: symbol[] = [];
        const observe = (pref: string, sync: () => void) => {
            try {
                observers.push(Zotero.Prefs.registerObserver(pref, sync, true));
            } catch { /* preferences may be closing */ }
        };
        observe(
            'extensions.zotero.beaver.backgroundProcessingEnabled',
            () => setEnabled(getPref('backgroundProcessingEnabled') === true),
        );
        observe(
            'extensions.zotero.beaver.backgroundProcessingContinuous',
            () => setContinuous(getPref('backgroundProcessingContinuous') === true),
        );
        return () => {
            for (const observer of observers) {
                try { Zotero.Prefs.unregisterObserver(observer); } catch { /* best effort */ }
            }
        };
    }, []);

    const updateEnabled = (next: boolean) => {
        setEnabled(next);
        setPref('backgroundProcessingEnabled', next);
        if (!next) Zotero.Beaver?.backgroundExtractor?.cancelImmediateDrain();
        Zotero.Beaver?.processingReconciler?.notify();
        Zotero.Beaver?.backgroundExtractor?.notify();
    };

    const updateContinuous = (next: boolean) => {
        setContinuous(next);
        setPref('backgroundProcessingContinuous', next);
        // Continuous already keeps the idle gate open; a leftover Process now
        // drain would keep running after the user turns this back off.
        if (next) Zotero.Beaver?.backgroundExtractor?.cancelImmediateDrain();
        Zotero.Beaver?.backgroundExtractor?.notify();
        void refresh();
    };

    const processNow = async () => {
        await Zotero.Beaver?.processingReconciler?.reconcileNow();
        Zotero.Beaver?.backgroundExtractor?.requestImmediateDrain();
        await refresh();
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

    const cache = status.documentCache;
    const [clearingCache, setClearingCache] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const readingIssues = status.issues.filter((group) => group.reason !== 'index_failed');
    const indexIssues = status.issues.filter((group) => group.reason === 'index_failed');
    const clearCache = async () => {
        setClearingCache(true);
        setActionError(null);
        try {
            await clearDocumentCache();
        } catch (error) {
            setActionError(error instanceof Error ? error.message : 'Could not clear the local cache.');
        } finally {
            await refresh();
            setClearingCache(false);
        }
    };
    const issueRow = (group: typeof status.issues[number]) => (
        <ProcessingIssueGroupRow
            key={group.reason}
            group={group}
            hasOcrAccess={hasOcrAccess}
            hasSearchAccess={hasSearchAccess}
            updatedAt={status.updatedAt}
            hasBorder
            onRetry={retryIssues}
        />
    );

    return (
        <>
            {hasSearchAccess && (
                <>
                    <SectionLabel>Full-text Search</SectionLabel>
                    <SettingsGroup>
                        <SettingsRow
                            title={status.coverage === null
                                ? status.coverageError ? 'Server search status unavailable' : 'Checking the server search index…'
                                : status.coverage.namespace_exists ? 'Server search index available' : 'Server search index not available yet'}
                            description={<>
                                {!enabled && <span>Updates paused. </span>}
                                {status.coverageError
                                    ? 'Could not check the server search index. Showing its last known status when available.'
                                    : 'Full-text search finds content inside indexed attachments. Detailed attachment coverage is not available yet.'}
                                {status.coverageUpdatedAt && <span> Last checked {new Date(status.coverageUpdatedAt).toLocaleString()}.</span>}
                            </>}
                        />
                        {indexIssues.map(issueRow)}
                        {readingIssues.length > 0 && <div className="font-color-secondary text-base" style={{ padding: '8px 12px' }}>
                            Some attachments may be missing from search because they could not be read. See the reading problems below.
                        </div>}
                    </SettingsGroup>
                </>
            )}

            <SectionLabel>Background Processing</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title={hasSearchAccess ? 'Keep full-text search up to date' : 'Process files in the background'}
                    description={hasSearchAccess
                        ? 'Background processing is required to keep full-text search up to date. Turn it off to pause updates; existing search results are retained.'
                        : 'By default, Beaver processes files when you use them. Enable background processing to prepare files ahead of time for faster responses.'}
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
                        continuous={continuous}
                        onProcessNow={processNow}
                        onStopDrain={stopDrain}
                    />
                )}
                <SettingsRow
                    title="Also run while Zotero is in use"
                    description="When off, background preparation waits until Zotero is idle. Files you request are still processed when needed."
                    disabled={!enabled}
                    hasBorder
                    onClick={() => {
                        if (!enabled) return;
                        updateContinuous(!continuous);
                    }}
                    control={<input
                        type="checkbox"
                        aria-label="Also run while Zotero is in use"
                        checked={continuous}
                        disabled={!enabled}
                        onChange={(event) => updateContinuous(event.target.checked)}
                        onClick={(event) => event.stopPropagation()}
                    />}
                />
            </SettingsGroup>

            <SectionLabel>Local Document Cache</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title={cache
                        ? (typeof cache.cached_document_count === 'number' ? `${plural(cache.cached_document_count, 'document')} cached · ` : '')
                            + formatBytes(cache.payload_total_bytes)
                            + (cache.payload_budget_bytes > 0 ? ` of ${formatBytes(cache.payload_budget_bytes)}` : '')
                        : status.updatedAt === null ? 'Checking local storage…' : 'Local cache status unavailable'}
                    description="Cached text helps Beaver respond faster. Older cached text is removed as needed to stay within the storage limit. Clearing this cache leaves your original files and server search index intact."
                    control={<Button variant="outline" onClick={clearCache} disabled={clearingCache || !cache} loading={clearingCache}>
                        Clear local cache
                    </Button>}
                />
                {hasOcrAccess && <div className="font-color-secondary text-base" style={{ padding: '8px 12px' }}>
                    Scanned files may need preparation again after their cached text is removed.
                </div>}
                {actionError && <div role="alert" className="font-color-red text-base" style={{ padding: '8px 12px' }}>{actionError}</div>}
            </SettingsGroup>

            <SectionLabel>Files Beaver Can’t Read</SectionLabel>
            <SettingsGroup>
                <div className="font-color-secondary text-base" style={{ padding: '8px 12px' }}>
                    {status.error
                        ? 'Could not update reading problems. Previously reported problems are shown below.'
                        : status.updatedAt === null
                            ? 'Checking known reading problems…'
                            : readingIssues.length > 0
                                ? `${plural(readingIssues.reduce((sum, group) => sum + group.count, 0), 'attachment')} could not be read. Includes files Beaver has attempted to process.`
                                : 'No reading problems found in files checked so far.'}
                </div>
                {readingIssues.map(issueRow)}
            </SettingsGroup>
        </>
    );
}
