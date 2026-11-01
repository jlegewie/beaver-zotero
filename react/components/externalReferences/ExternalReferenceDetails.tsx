import React from 'react';
import { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { externalRecordPresentation } from '@beaver/agent-core/citations/externalRecordDisplay';
import { formatAuthors } from './utils';
import { DetailsActions, DetailsFrame, RecordLinks, RetractedBanner } from './ExternalRecordParts';
import PubMedReferenceDetails from './PubMedReferenceDetails';
import TrialReferenceDetails from './TrialReferenceDetails';

interface ExternalReferenceDetailsProps {
    item: ExternalReference;
}

const GenericReferenceDetails: React.FC<ExternalReferenceDetailsProps> = ({ item }) => {
    const authors = formatAuthors(item.authors);
    const publicationTitle = item.journal?.name || item.venue;
    const year = item.year;

    return (
        <DetailsFrame
            header={(
                <>
                    {item.is_retracted && <RetractedBanner />}
                    <div className="text-lg font-bold font-color-primary leading-tight pr-8">{item.title || 'Untitled Item'}</div>
                    {authors && (
                        <div className="font-color-primary">{authors}</div>
                    )}
                    {(publicationTitle || year) && (
                        <div className="font-color-secondary">
                            {publicationTitle && <i>{publicationTitle}</i>}
                            {publicationTitle && year && ', '}
                            {year}
                        </div>
                    )}
                    <RecordLinks item={item} />
                </>
            )}
            footer={<DetailsActions item={item} />}
        >
            {item.abstract && (
                <div className="display-flex flex-col gap-1">
                    <div className="font-bold font-color-primary uppercase tracking-wider sticky top-0 z-10 pb-1">Abstract</div>
                    <div className="font-color-primary leading-relaxed select-text">
                        {item.abstract.trim()}
                    </div>
                </div>
            )}
        </DetailsFrame>
    );
};

/** Details of one external record, laid out for its source. */
const ExternalReferenceDetails: React.FC<ExternalReferenceDetailsProps> = ({ item }) => {
    switch (externalRecordPresentation(item.source, item)) {
        case 'pubmed':
            return <PubMedReferenceDetails item={item} />;
        case 'trial':
            return <TrialReferenceDetails item={item} />;
        default:
            return <GenericReferenceDetails item={item} />;
    }
};

export default ExternalReferenceDetails;
