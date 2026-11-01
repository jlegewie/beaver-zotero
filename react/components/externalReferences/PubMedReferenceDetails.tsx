import React from 'react';
import { workDetails, type ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { citationLine, publicationTypeBadges, recordPmid } from '@beaver/agent-core/citations/externalRecordDisplay';
import { DetailsActions, DetailsFrame, DetailsSection, RecordBadge, RecordLinks, RetractedBanner } from './ExternalRecordParts';

/**
 * PubMed record details: the structured abstract with its section headings,
 * MeSH terms with major topics marked, and PubMed · PMC · DOI links.
 */
const PubMedReferenceDetails: React.FC<{ item: ExternalReference }> = ({ item }) => {
    const details = workDetails(item);
    const sections = (details?.abstract_sections ?? []).filter((section) => section.text?.trim());
    const mesh = (details?.mesh ?? []).filter((term) => term.descriptor);
    const line = citationLine(item);
    const pmid = recordPmid(item);
    const badges = publicationTypeBadges(item);
    const authors = (item.authors ?? []).join(', ');

    return (
        <DetailsFrame
            header={(
                <>
                    {item.is_retracted && <RetractedBanner />}
                    <div className="text-lg font-bold font-color-primary leading-tight pr-8">{item.title || 'Untitled Item'}</div>
                    {authors && <div className="font-color-primary">{authors}</div>}
                    {line && <div className="font-color-secondary"><i>{line}</i></div>}
                    {(pmid || badges.length > 0) && (
                        <div className="display-flex flex-row flex-wrap items-center gap-1 text-sm font-color-tertiary">
                            {pmid && <span className="select-text">PMID: {pmid}</span>}
                            {badges.map((badge) => <RecordBadge key={badge} label={badge} />)}
                        </div>
                    )}
                    <RecordLinks item={item} />
                </>
            )}
            footer={<DetailsActions item={item} />}
        >
            {sections.length > 0 ? (
                <DetailsSection title="Abstract">
                    <div className="display-flex flex-col gap-2">
                        {sections.map((section, index) => (
                            <div key={index}>
                                {section.label && <span className="font-bold">{section.label}: </span>}
                                {section.text!.trim()}
                            </div>
                        ))}
                    </div>
                </DetailsSection>
            ) : item.abstract ? (
                <DetailsSection title="Abstract">{item.abstract.trim()}</DetailsSection>
            ) : null}
            {mesh.length > 0 && (
                <DetailsSection title="MeSH terms">
                    <div className="display-flex flex-row flex-wrap gap-1">
                        {mesh.map((term, index) => (
                            <span
                                key={`${term.descriptor}-${index}`}
                                className={term.major ? 'font-bold' : 'font-color-secondary'}
                                title={term.major ? 'Major topic' : undefined}
                            >
                                {term.descriptor}{term.major ? '*' : ''}
                                {term.qualifiers?.length ? `/${term.qualifiers.join('/')}` : ''}
                                {index < mesh.length - 1 ? ';' : ''}
                            </span>
                        ))}
                    </div>
                    <div className="text-sm font-color-tertiary mt-1">* Major topic</div>
                </DetailsSection>
            )}
        </DetailsFrame>
    );
};

export default PubMedReferenceDetails;
