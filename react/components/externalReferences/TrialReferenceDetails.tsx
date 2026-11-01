import React from 'react';
import { trialDetails, type ExternalReference } from '@beaver/agent-core/types/externalReferences';
import {
    recordNct,
    registryText,
    trialDateRange,
    trialFactsLine,
    trialDocumentLabel,
    trialStatusDisplay,
} from '@beaver/agent-core/citations/externalRecordDisplay';
import { DetailsActions, DetailsFrame, DetailsSection, RecordBadge, RecordLink, RecordLinks } from './ExternalRecordParts';

function formatSize(bytes: number | null | undefined): string | null {
    if (!bytes || bytes <= 0) return null;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Trial registration details: the official title, the brief summary, every
 * condition and intervention, the registry's documents, and links.
 */
const TrialReferenceDetails: React.FC<{ item: ExternalReference }> = ({ item }) => {
    const details = trialDetails(item)!;
    const status = trialStatusDisplay(details);
    const nct = recordNct(item);
    const facts = trialFactsLine(details);
    const dates = trialDateRange(details);
    const interventions = (details.interventions ?? []).filter((intervention) => intervention.name);
    const documents = details.documents ?? [];
    const briefTitle = details.brief_title && details.brief_title !== item.title ? details.brief_title : null;

    return (
        <DetailsFrame
            header={(
                <>
                    <div className="text-lg font-bold font-color-primary leading-tight pr-8">{item.title || briefTitle || nct || 'Untitled trial'}</div>
                    {briefTitle && <div className="font-color-secondary">{briefTitle}{details.acronym ? ` (${details.acronym})` : ''}</div>}
                    <div className="display-flex flex-row flex-wrap items-center gap-1 text-sm">
                        {status && <RecordBadge label={status.label} tone={status.tone} tooltip={status.hint} />}
                        {details.has_results && <RecordBadge label="Results posted" tone="blue" />}
                        {nct && <span className="font-color-tertiary select-text">{nct}</span>}
                    </div>
                    {status?.tone === 'red' && details.why_stopped && (
                        <div className="text-sm font-color-secondary">Why stopped: {registryText(details.why_stopped)}</div>
                    )}
                    {facts && <div className="font-color-secondary text-sm">{facts}</div>}
                    {details.lead_sponsor && <div className="font-color-secondary text-sm">Sponsor: {details.lead_sponsor}</div>}
                    {dates && <div className="font-color-tertiary text-sm">{dates}</div>}
                    <RecordLinks item={item} />
                </>
            )}
            footer={<DetailsActions item={item} />}
        >
            {item.abstract && <DetailsSection title="Brief summary"><div style={{ whiteSpace: 'pre-wrap' }}>{registryText(item.abstract.trim())}</div></DetailsSection>}
            {(details.conditions?.length ?? 0) > 0 && (
                <DetailsSection title="Conditions">{details.conditions!.join(', ')}</DetailsSection>
            )}
            {interventions.length > 0 && (
                <DetailsSection title="Interventions">
                    {interventions.map((intervention) => intervention.type
                        ? `${intervention.name} (${intervention.type.replace(/_/g, ' ').toLowerCase()})`
                        : intervention.name).join(', ')}
                </DetailsSection>
            )}
            {documents.length > 0 && (
                <DetailsSection title="Documents">
                    <div className="display-flex flex-col gap-05">
                        {documents.map((document, index) => {
                            const label = trialDocumentLabel(document);
                            const meta = [document.date, formatSize(document.size)].filter(Boolean).join(', ');
                            return (
                                <div key={`${document.url ?? label}-${index}`}>
                                    {document.url ? <RecordLink url={document.url}>{label}</RecordLink> : label}
                                    {meta && <span className="font-color-tertiary"> ({meta})</span>}
                                </div>
                            );
                        })}
                    </div>
                </DetailsSection>
            )}
            {details.data_as_of && (
                <div className="text-sm font-color-tertiary">Data as of {details.data_as_of} · Source: ClinicalTrials.gov</div>
            )}
        </DetailsFrame>
    );
};

export default TrialReferenceDetails;
