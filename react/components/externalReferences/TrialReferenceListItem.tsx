import React from 'react';
import { trialDetails, type ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { getHost } from '@beaver/agent-ui/host';
import {
    primaryExternalUrl,
    recordNct,
    trialDateRange,
    trialFactsLine,
    trialHasProtocolOrSap,
    trialHeadline,
    trialStatusDisplay,
} from '@beaver/agent-core/citations/externalRecordDisplay';
import { RecordBadge, capList, openExternal } from './ExternalRecordParts';
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

/**
 * A ClinicalTrials.gov registration as the registry shows it: the brief
 * title, a status badge, phase, study type, enrollment, the lead sponsor,
 * conditions and interventions, dates, and the Results posted and
 * Protocol/SAP badges.
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
    const status = trialStatusDisplay(details);
    const nct = recordNct(item);
    const facts = trialFactsLine(details);
    const conditions = capList(details.conditions, ROW_LIST_LIMIT);
    const interventions = capList(
        (details.interventions ?? []).map((intervention) => intervention.name).filter((name): name is string => !!name),
        ROW_LIST_LIMIT,
    );
    const dates = trialDateRange(details);

    return (
        <ReferenceRowFrame item={item} isHovered={isHovered} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
            <div className="display-flex flex-col gap-1 min-w-0">
                <div
                    className={`font-color-primary ${primaryUrl ? 'cursor-pointer' : ''}`}
                    onClick={primaryUrl ? () => openExternal(primaryUrl) : undefined}
                >
                    {trialHeadline(item)}
                </div>
                <div className="display-flex flex-row flex-wrap items-center gap-1 text-sm">
                    {status && <RecordBadge label={status.label} tone={status.tone} tooltip={status.hint} />}
                    {details.has_results && <RecordBadge label="Results posted" tone="blue" />}
                    {trialHasProtocolOrSap(details) && <RecordBadge label="Protocol/SAP" />}
                    {nct && <span className="font-color-tertiary select-text">{nct}</span>}
                </div>
                {facts && <div className="font-color-secondary text-sm truncate">{facts}</div>}
                {details.lead_sponsor && (
                    <div className="font-color-secondary text-sm truncate">Sponsor: {details.lead_sponsor}</div>
                )}
                {conditions.shown.length > 0 && (
                    <div className="font-color-secondary text-sm">
                        Conditions: {listWithMore(conditions.shown, conditions.more)}
                    </div>
                )}
                {interventions.shown.length > 0 && (
                    <div className="font-color-secondary text-sm">
                        Interventions: {listWithMore(interventions.shown, interventions.more)}
                    </div>
                )}
                {dates && <div className="font-color-tertiary text-sm">{dates}</div>}
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
