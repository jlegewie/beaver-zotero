import React from 'react';
import { trialDetails, type ExternalReference } from '@beaver/agent-core/types/externalReferences';
import {
    formatRegistryDate,
    registryText,
    trialDocumentLabel,
    trialHeadline,
} from '@beaver/agent-core/citations/externalRecordDisplay';
import { DetailsActions, DetailsFrame, DetailsSection, RecordFacts, RecordLink, RecordLinks } from './ExternalRecordParts';
import { TrialTags, trialSummaryLine } from './TrialReferenceListItem';

function formatSize(bytes: number | null | undefined): string | null {
    if (!bytes || bytes <= 0) return null;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function interventionLabel(name: string, type: string | null | undefined): string {
    if (!type) return name;
    const kind = type.replace(/_/g, ' ').toLowerCase();
    return `${name} (${kind})`;
}

/**
 * Trial registration details: the same headline and tags as the row, the
 * registry facts, the brief summary, every condition and intervention, the
 * documents on file, and the registry's data date.
 */
const TrialReferenceDetails: React.FC<{ item: ExternalReference }> = ({ item }) => {
    const details = trialDetails(item)!;
    const headline = trialHeadline(item);
    const officialTitle = item.title && item.title !== headline ? item.title : null;
    const interventions = (details.interventions ?? []).filter((intervention) => intervention.name);
    const documents = details.documents ?? [];
    const summary = trialSummaryLine(item, details);

    return (
        <DetailsFrame
            header={(
                <>
                    <div className="text-lg font-bold font-color-primary leading-tight pr-8">
                        {headline}{details.acronym ? ` (${details.acronym})` : ''}
                    </div>
                    <TrialTags details={details} />
                    {summary && <div className="font-color-secondary text-sm">{summary}</div>}
                    <RecordLinks item={item} />
                </>
            )}
            footer={<DetailsActions item={item} />}
        >
            <DetailsSection title="Study">
                <RecordFacts facts={[
                    ['Official title', officialTitle],
                    ['Sponsor', details.lead_sponsor],
                    ['Why stopped', details.why_stopped ? registryText(details.why_stopped) : null],
                    ['Started', formatRegistryDate(details.start_date)],
                    ['Primary completion', formatRegistryDate(details.primary_completion_date)],
                    ['First posted', formatRegistryDate(details.first_posted)],
                    ['Last updated', formatRegistryDate(details.last_update_posted)],
                ]} />
            </DetailsSection>
            {item.abstract && (
                <DetailsSection title="Brief summary">
                    <div style={{ whiteSpace: 'pre-wrap' }}>{registryText(item.abstract.trim())}</div>
                </DetailsSection>
            )}
            {(details.conditions?.length ?? 0) > 0 && (
                <DetailsSection title="Conditions">
                    <div className="display-flex flex-row flex-wrap gap-1">
                        {details.conditions!.map((condition, index) => (
                            <span key={`${condition}-${index}`} className="ext-chip">{condition}</span>
                        ))}
                    </div>
                </DetailsSection>
            )}
            {interventions.length > 0 && (
                <DetailsSection title="Interventions">
                    <div className="display-flex flex-row flex-wrap gap-1">
                        {interventions.map((intervention, index) => (
                            <span key={`${intervention.name}-${index}`} className="ext-chip">
                                {interventionLabel(intervention.name!, intervention.type)}
                            </span>
                        ))}
                    </div>
                </DetailsSection>
            )}
            {documents.length > 0 && (
                <DetailsSection title="Documents">
                    <div className="display-flex flex-col gap-1 text-sm">
                        {documents.map((document, index) => {
                            const label = trialDocumentLabel(document);
                            const meta = [formatRegistryDate(document.date), formatSize(document.size)].filter(Boolean).join(' · ');
                            return (
                                <div key={`${document.url ?? label}-${index}`}>
                                    {document.url ? <RecordLink url={document.url}>{label}</RecordLink> : label}
                                    {meta && <span className="font-color-secondary"> · {meta}</span>}
                                </div>
                            );
                        })}
                    </div>
                </DetailsSection>
            )}
            {details.data_as_of && (
                <div className="text-sm font-color-secondary">
                    Data as of {formatRegistryDate(details.data_as_of)} · Source: ClinicalTrials.gov
                </div>
            )}
        </DetailsFrame>
    );
};

export default TrialReferenceDetails;
