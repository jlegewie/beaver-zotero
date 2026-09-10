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

/**
 * Status row: one sentence, a segmented progress bar and its legend. Counts
 * come from disjoint ledger text-readiness categories. Index failures do not
 * change readability; scans awaiting an available OCR stage remain pending.
 */
const ProcessingStatusRow: React.FC<{
    status: BackgroundProcessingStatus;
    continuous: boolean;
    hasSearchAccess: boolean;
    onProcessNow: () => void;
    onStopDrain: () => void;
}> = ({ status, continuous, hasSearchAccess, onProcessNow, onStopDrain }) => {
    const sentence = describeStatus(status, continuous);
    const { total, readable, unreadable, awaitingOcr, upserted } = status.ledger;
    const pending = Math.max(0, total - readable - unreadable);
    const pct = (count: number) => (total > 0 ? `${(count / total) * 100}%` : '0%');

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
                        content="The current file will finish. Processing resumes when Zotero is idle."
                        usePortal
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
                        content="Processing will start once Zotero is ready."
                        disabled={!sentence.processNowBlocked}
                        usePortal
                        placement="top"
                    >
                        <Button
                            variant="outline"
                            className="flex-shrink-0"
                            rightIcon={PlayIcon}
                            disabled={sentence.processNowBlocked}
                            ariaLabel={sentence.processNowBlocked
                                ? 'Process now. Waiting for Zotero to be ready.'
                                : undefined}
                            onClick={onProcessNow}
                        >
                            Process now
                        </Button>
                    </Tooltip>
                ) : null}
            </div>

            {total > 0 && (
                <>
                    <div
                        aria-hidden="true"
                        className="display-flex flex-row overflow-hidden"
                        style={{ height: '6px', borderRadius: '3px', background: 'var(--fill-quinary)' }}
                    >
                        <div style={{ width: pct(readable), background: 'var(--accent-blue)' }} />
                        <div style={{ width: pct(unreadable), background: 'var(--tag-red)', opacity: 0.7 }} />
                    </div>
                    <div className="display-flex flex-row items-center flex-wrap gap-4 text-sm font-color-secondary">
                        <Legend color="var(--accent-blue)" label={`${readable.toLocaleString()} readable`} />
                        {hasSearchAccess && (
                            <Legend color="var(--accent-blue)" hollow label={`${upserted.toLocaleString()} in the search index`} />
                        )}
                        {unreadable > 0 && (
                            <Legend color="var(--tag-red)" label={`${unreadable.toLocaleString()} could not be read`} />
                        )}
                        {awaitingOcr > 0 && (
                            <Legend color="var(--fill-quinary)" label={`${awaitingOcr.toLocaleString()} waiting for OCR`} />
                        )}
                        {pending - awaitingOcr > 0 && (
                            <Legend color="var(--fill-quinary)" label={`${(pending - awaitingOcr).toLocaleString()} not processed yet`} />
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

const Legend: React.FC<{ color: string; label: string; hollow?: boolean }> = ({ color, label, hollow }) => (
    <span className="display-flex flex-row items-center gap-1">
        <span
            aria-hidden="true"
            style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: hollow ? 'transparent' : color,
                border: hollow ? `1.5px solid ${color}` : 'none',
                boxSizing: 'border-box',
            }}
        />
        {label}
    </span>
);

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
        const targets = refs ?? await db.getProcessingIssueRefs(
            { hasOcrAccess, hasSearchIndexAccess: hasSearchAccess }, reason,
        );
        if (targets.length > 0) await reconciler.retryAttachments(targets);
        await refresh();
    };

    const cache = status.documentCache;

    return (
        <>
            <SectionLabel>Background Processing</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title="Process files in the background"
                    description="Beaver reads the PDFs and other attachments in your library ahead of time, so it can answer questions about them without opening each file first."
                    onClick={() => updateEnabled(!enabled)}
                    control={<input
                        type="checkbox"
                        aria-label="Process files in the background"
                        checked={enabled}
                        onChange={(event) => updateEnabled(event.target.checked)}
                        onClick={(event) => event.stopPropagation()}
                    />}
                />
                {enabled && (
                    <ProcessingStatusRow
                        status={status}
                        continuous={continuous}
                        hasSearchAccess={hasSearchAccess}
                        onProcessNow={processNow}
                        onStopDrain={stopDrain}
                    />
                )}
                <SettingsRow
                    title="Also run while Zotero is in use"
                    description="When off, Beaver only processes files while Zotero is idle, so it never slows you down."
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
                <SettingsRow
                    title="Storage on this computer"
                    hasBorder
                    description={cache
                        ? `${formatBytes(cache.payload_total_bytes)} used for ${plural(cache.payload_count, 'document')}`
                            + (cache.payload_budget_bytes > 0
                                ? ` · ${formatBytes(cache.payload_budget_bytes)} limit`
                                : '')
                        : 'Extracted text is kept on disk so files are not read twice.'}
                />
            </SettingsGroup>

            {enabled && status.issues.length > 0 && (
                <>
                    <SectionLabel>Files Beaver Could Not Read</SectionLabel>
                    <SettingsGroup>
                        <div className="font-color-secondary text-base" style={{ padding: '8px 12px' }}>
                            {plural(status.issues.reduce((sum, group) => sum + group.count, 0), 'attachment')} could
                            not be processed.
                        </div>
                        {status.issues.map((group) => (
                            <ProcessingIssueGroupRow
                                key={group.reason}
                                group={group}
                                hasOcrAccess={hasOcrAccess}
                                hasSearchAccess={hasSearchAccess}
                                updatedAt={status.updatedAt}
                                hasBorder
                                onRetry={retryIssues}
                            />
                        ))}
                    </SettingsGroup>
                </>
            )}
        </>
    );
}
