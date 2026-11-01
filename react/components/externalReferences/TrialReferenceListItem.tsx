import React from 'react';
import { trialDetails, type ExternalReference, type TrialDetails } from '@beaver/agent-core/types/externalReferences';
import { getHost } from '@beaver/agent-ui/host';
import {
    formatRegistryDate,
    primaryExternalUrl,
    recordNct,
    trialDesignLine,
    trialHasProtocolOrSap,
    trialHeadline,
    trialStatusDisplay,
} from '@beaver/agent-core/citations/externalRecordDisplay';
import { RecordBadge, RecordFacts, RecordTags, capList, openExternal } from './ExternalRecordParts';
import { ReferenceRowFrame } from './ExternalReferenceListItem';

/** How many conditions and interventions a row lists. */
const ROW_LIST_LIMIT = 5;

interface TrialReferenceListItemProps {
    item: ExternalReference;
    /** Source of the results view the row is in; selects the primary link. */
    viewSource?: string | null;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
}

function listWithMore(values: string[], more: number): string {
    return more > 0 ? `${values.join(', ')} +${more} more` : values.join(', ');
}

/** The trial's tags: recruitment status, posted results, and a protocol or SAP on file. */
export const TrialTags: React.FC<{ details: TrialDetails }> = ({ details }) => {
    const status = trialStatusDisplay(details);
    return (
        <RecordTags>
            {status && <RecordBadge label={status.label} tone={status.tone} tooltip={status.hint} />}
            {details.has_results && <RecordBadge label="Results posted" tone="blue" />}
            {trialHasProtocolOrSap(details) && (
                <RecordBadge label="Protocol & SAP" tooltip="The registry has the study protocol or statistical analysis plan" />
            )}
        </RecordTags>
    );
};

/** "NCT04368728 · Phase 2/3 · Interventional · 46,969 participants" */
export function trialSummaryLine(item: ExternalReference, details: TrialDetails): string {
    return [recordNct(item), trialDesignLine(details)].filter(Boolean).join(' · ');
}

/**
 * A ClinicalTrials.gov registration: the brief title, its status tags, the
 * design at a glance, then labelled facts (sponsor, up to five conditions
 * and interventions, start and primary completion dates).
 */
const TrialReferenceListItem: React.FC<TrialReferenceListItemProps> = ({
    item,
    viewSource,
    isHovered,
    onMouseEnter,
    onMouseLeave,
}) => {
    const details = trialDetails(item)!;
    const primaryUrl = primaryExternalUrl(item, viewSource ?? 'clinicaltrials');
    const conditions = capList(details.conditions, ROW_LIST_LIMIT);
    const interventions = capList(
        (details.interventions ?? []).map((intervention) => intervention.name).filter((name): name is string => !!name),
        ROW_LIST_LIMIT,
    );
    const summary = trialSummaryLine(item, details);

    return (
        <ReferenceRowFrame item={item} isHovered={isHovered} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
            <div className="display-flex flex-col gap-1 min-w-0">
                <div
                    className={`font-color-primary ${primaryUrl ? 'cursor-pointer' : ''}`}
                    onClick={primaryUrl ? () => openExternal(primaryUrl) : undefined}
                >
                    {trialHeadline(item)}
                </div>
                <TrialTags details={details} />
                {summary && <div className="font-color-secondary text-sm">{summary}</div>}
                <div className="mt-1">
                    <RecordFacts facts={[
                        ['Sponsor', details.lead_sponsor],
                        ['Conditions', conditions.shown.length ? listWithMore(conditions.shown, conditions.more) : null],
                        ['Interventions', interventions.shown.length ? listWithMore(interventions.shown, interventions.more) : null],
                        ['Started', formatRegistryDate(details.start_date)],
                        ['Primary completion', formatRegistryDate(details.primary_completion_date)],
                    ]} />
                </div>
            </div>
            {getHost().components?.externalReferenceActions({
                item,
                detailsButtonMode: 'icon-only',
                webButtonMode: 'icon-only',
                pdfButtonMode: 'icon-only',
                webUrl: primaryUrl,
                showCitationCount: false,
            })}
        </ReferenceRowFrame>
    );
};

export default TrialReferenceListItem;
