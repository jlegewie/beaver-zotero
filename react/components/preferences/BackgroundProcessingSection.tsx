import React, { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
    hasOcrAccessAtom,
    hasSearchIndexAccessAtom,
    localZoteroLibrariesAtom,
} from '../../atoms/profile';
import { backgroundProcessingStatusAtom } from '../../atoms/backgroundProcessing';
import { useBackgroundProcessingStatus } from '../../hooks/useBackgroundProcessingStatus';
import { getPref, setPref } from '../../../src/utils/prefs';
import { getIndexScopeRef } from '../../../src/utils/zoteroUtils';
import {
    backgroundProcessingLibraryToken,
    getBackgroundProcessingSkipTokens,
} from '../../../src/services/backgroundProcessing/utils';
import Button from '../ui/Button';
import { SettingsGroup, SettingsRow, SectionLabel } from './components/SettingsElements';

export default function BackgroundProcessingSection(props: {
    placement?: 'search' | 'advanced';
}): React.ReactElement | null {
    const hasOcrAccess = useAtomValue(hasOcrAccessAtom);
    const hasSearchAccess = useAtomValue(hasSearchIndexAccessAtom);
    const libraries = useAtomValue(localZoteroLibrariesAtom);
    const status = useAtomValue(backgroundProcessingStatusAtom);
    const refresh = useBackgroundProcessingStatus({
        includeCoverage: true,
        includeFailures: true,
        pollIntervalMs: 15_000,
    });
    const [enabled, setEnabled] = useState(
        () => getPref('backgroundProcessingEnabled') === true,
    );
    const [continuous, setContinuous] = useState(
        () => getPref('backgroundProcessingContinuous') === true,
    );
    const [skipTokens, setSkipTokens] = useState<string[]>(
        () => [...getBackgroundProcessingSkipTokens()],
    );
    const [showFailures, setShowFailures] = useState(false);
    const entitled = hasOcrAccess || hasSearchAccess;
    const placement = props.placement ?? 'search';

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

    const toggleLibrary = (token: string, shouldProcess: boolean) => {
        const next = shouldProcess
            ? skipTokens.filter((entry) => entry !== token)
            : [...new Set([...skipTokens, token])];
        setSkipTokens(next);
        setPref('backgroundProcessingLibrariesToSkip', JSON.stringify(next));
        Zotero.Beaver?.processingReconciler?.notify();
    };

    const updateEnabled = (next: boolean) => {
        setEnabled(next);
        setPref('backgroundProcessingEnabled', next);
        Zotero.Beaver?.processingReconciler?.notify();
        Zotero.Beaver?.backgroundExtractor?.notify();
    };

    const updateContinuous = (next: boolean) => {
        setContinuous(next);
        setPref('backgroundProcessingContinuous', next);
        Zotero.Beaver?.backgroundExtractor?.notify();
    };

    const coverageByScope = useMemo(() => new Map(
        (status.coverage?.documents ?? [])
            .filter((entry) => entry.source === 'zotero_attachment')
            .map((entry) => [entry.scope_ref, entry]),
    ), [status.coverage]);

    const processNow = async () => {
        await Zotero.Beaver?.processingReconciler?.reconcileNow();
        Zotero.Beaver?.backgroundExtractor?.notify();
        await refresh();
    };

    if ((placement === 'search' && !entitled) || (placement === 'advanced' && entitled)) {
        return null;
    }

    return (
        <>
            <SectionLabel>Background File Processing</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title="Process library files in the background"
                    description={entitled
                        ? 'Extracts readable attachments and keeps entitled OCR and cloud search coverage current.'
                        : 'Advanced: warms Beaver’s local extraction cache. OCR and cloud indexing require an eligible plan.'}
                    onClick={() => updateEnabled(!enabled)}
                    control={<input
                        type="checkbox"
                        aria-label="Process library files in the background"
                        checked={enabled}
                        onChange={(event) => updateEnabled(event.target.checked)}
                        onClick={(event) => event.stopPropagation()}
                    />}
                />
                <SettingsRow
                    title="Process continuously"
                    description="Runs backlog jobs while you are active instead of waiting for Zotero to be idle."
                    disabled={!enabled}
                    hasBorder
                    onClick={() => {
                        if (!enabled) return;
                        updateContinuous(!continuous);
                    }}
                    control={<input
                        type="checkbox"
                        aria-label="Process continuously"
                        checked={continuous}
                        disabled={!enabled}
                        onChange={(event) => updateContinuous(event.target.checked)}
                        onClick={(event) => event.stopPropagation()}
                    />}
                />
                <SettingsRow
                    title="Processing status"
                    hasBorder
                    description={
                        <div className="display-flex flex-col gap-05">
                            <span>
                                {status.ledger.extracted.toLocaleString()} extracted · {' '}
                                {status.ledger.ocrDone.toLocaleString()} OCR complete · {' '}
                                {status.ledger.upserted.toLocaleString()} indexed
                            </span>
                            <span>
                                {status.queue.pending.toLocaleString()} queued · {' '}
                                {status.ledger.skipped.toLocaleString()} skipped · {' '}
                                {(status.ledger.failed + status.queue.dead).toLocaleString()} failed
                            </span>
                            {status.ledger.oldestPendingAt && (
                                <span>Oldest pending: {new Date(`${status.ledger.oldestPendingAt}Z`).toLocaleString()}</span>
                            )}
                            {status.error && <span className="font-color-red">{status.error}</span>}
                        </div>
                    }
                    control={<div className="display-flex flex-row gap-2">
                        <Button variant="outline" onClick={() => void refresh()}>Refresh</Button>
                        <Button variant="outline" onClick={() => void processNow()}>Process now</Button>
                    </div>}
                />
                {(status.ledger.failed > 0 || status.queue.dead > 0) && (
                    <SettingsRow
                        title="Failures"
                        hasBorder
                        description={showFailures
                            ? <div className="display-flex flex-col gap-1">
                                <span>{status.ledger.failed} attachment stage failure(s) and {status.queue.dead} dead-lettered job(s).</span>
                                {status.failures.slice(0, 10).map((failure, index) => (
                                    <span key={`${failure.source}-${failure.stage}-${failure.zoteroKey ?? index}`}>
                                        {failure.stage}{failure.zoteroKey ? ` · ${failure.libraryId}-${failure.zoteroKey}` : ''}
                                        {failure.error ? ` · ${failure.error}` : ''}
                                    </span>
                                ))}
                            </div>
                            : 'Review failed and dead-lettered background work.'}
                        control={<Button
                            variant="outline"
                            onClick={() => setShowFailures((value) => !value)}
                        >
                            {showFailures ? 'Hide details' : 'Show details'}
                        </Button>}
                    />
                )}
            </SettingsGroup>

            <SectionLabel>Libraries to Process</SectionLabel>
            <SettingsGroup>
                {libraries.map((library, index) => {
                    const token = backgroundProcessingLibraryToken(library.library_id);
                    if (!token) return null;
                    const checked = !skipTokens.includes(token);
                    return (
                        <SettingsRow
                            key={token}
                            title={library.name}
                            description={library.is_group ? 'Group library' : 'My Library'}
                            hasBorder={index > 0}
                            onClick={() => toggleLibrary(token, !checked)}
                            control={<input
                                type="checkbox"
                                checked={checked}
                                aria-label={`Process ${library.name}`}
                                onChange={(event) => toggleLibrary(token, event.target.checked)}
                                onClick={(event) => event.stopPropagation()}
                            />}
                        />
                    );
                })}
            </SettingsGroup>

            {hasSearchAccess && (
                <>
                    <SectionLabel>Cloud Index Coverage</SectionLabel>
                    <SettingsGroup>
                        {libraries.map((library, index) => {
                            const scopeRef = getIndexScopeRef(library.library_id);
                            const coverage = scopeRef ? coverageByScope.get(scopeRef) : undefined;
                            const token = backgroundProcessingLibraryToken(library.library_id);
                            const skipped = token != null && skipTokens.includes(token);
                            return (
                                <SettingsRow
                                    key={library.library_id}
                                    title={library.name}
                                    hasBorder={index > 0}
                                    description={skipped
                                        ? 'Skipped for background processing'
                                        : `${(coverage?.indexed ?? 0).toLocaleString()} indexed · ${(coverage?.pending ?? 0).toLocaleString()} pending · ${(coverage?.indexed_chunks ?? 0).toLocaleString()} chunks`}
                                />
                            );
                        })}
                    </SettingsGroup>
                </>
            )}
        </>
    );
}
