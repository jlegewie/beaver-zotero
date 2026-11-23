import React from 'react';
import { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { externalRecordPresentation } from '@beaver/agent-core/citations/externalRecordDisplay';
import { formatAuthors } from './utils';
import { DetailsActions, DetailsFrame, DetailsSection, RecordBadge, RecordLinks, RecordTags } from './ExternalRecordParts';
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
                    <div className="text-lg font-bold font-color-primary leading-tight pr-8">{item.title || 'Untitled Item'}</div>
                    {item.is_retracted && <RecordTags><RecordBadge label="Retracted" tone="red" /></RecordTags>}
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
            {item.abstract && <DetailsSection title="Abstract">{item.abstract.trim()}</DetailsSection>}
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
