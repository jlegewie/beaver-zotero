import React, { useState } from 'react';
import { workDetails, type ExternalReference, type MeshTerm } from '@beaver/agent-core/types/externalReferences';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { DetailsActions, DetailsFrame, DetailsSection, ExpandableNames, RecordLinks } from './ExternalRecordParts';
import { PubMedCitationLine, PubMedTags } from './PubMedReferenceListItem';

const MESH_HELP = 'Medical Subject Headings: the controlled vocabulary NLM indexers assign to each article. '
    + 'Main topics are what the article is chiefly about.';

function meshTitle(term: MeshTerm): string | undefined {
    return term.qualifiers?.length ? `${term.descriptor} / ${term.qualifiers.join(', ')}` : undefined;
}

/** MeSH terms: the main topics, with the other terms one click away. */
const MeshTerms: React.FC<{ terms: MeshTerm[] }> = ({ terms }) => {
    const [showAll, setShowAll] = useState(false);
    const main = terms.filter((term) => term.major);
    const other = terms.filter((term) => !term.major);
    const chips = (list: MeshTerm[], muted: boolean) => (
        <div className="display-flex flex-row flex-wrap gap-1">
            {list.map((term, index) => (
                <span key={`${term.descriptor}-${index}`} className="ext-chip" data-muted={muted || undefined} title={meshTitle(term)}>
                    {term.descriptor}
                </span>
            ))}
        </div>
    );
    return (
        <div className="display-flex flex-col gap-2">
            {main.length > 0 && (
                <div className="display-flex flex-col gap-1">
                    <div className="ext-subheading">Main topics</div>
                    {chips(main, false)}
                </div>
            )}
            {other.length > 0 && (showAll || !main.length) && (
                <div className="display-flex flex-col gap-1">
                    {main.length > 0 && <div className="ext-subheading">Other terms</div>}
                    {chips(other, true)}
                </div>
            )}
            {other.length > 0 && main.length > 0 && (
                <a className="text-link-muted text-sm" role="button" tabIndex={0} onClick={() => setShowAll((value) => !value)}>
                    {showAll ? 'Hide other terms' : `Show ${other.length} other term${other.length === 1 ? '' : 's'}`}
                </a>
            )}
        </div>
    );
};

/**
 * PubMed record details: tags, the full author list, the citation line,
 * links to the record elsewhere, the structured abstract, and MeSH terms.
 */
const PubMedReferenceDetails: React.FC<{ item: ExternalReference }> = ({ item }) => {
    const details = workDetails(item);
    const sections = (details?.abstract_sections ?? []).filter((section) => section.text?.trim());
    const mesh = (details?.mesh ?? []).filter((term) => term.descriptor);

    return (
        <DetailsFrame
            header={(
                <>
                    <div className="text-lg font-bold font-color-primary leading-tight pr-8">{item.title || 'Untitled Item'}</div>
                    <PubMedTags item={item} />
                    <ExpandableNames names={item.authors ?? []} className="font-color-primary" />
                    <PubMedCitationLine item={item} />
                    <RecordLinks item={item} />
                </>
            )}
            footer={<DetailsActions item={item} />}
        >
            {sections.length > 0 ? (
                <DetailsSection title="Abstract">
                    <div className="display-flex flex-col gap-3">
                        {sections.map((section, index) => (
                            <div key={index} className="display-flex flex-col gap-05">
                                {section.label && <div className="ext-subheading">{section.label}</div>}
                                <div>{section.text!.trim()}</div>
                            </div>
                        ))}
                    </div>
                </DetailsSection>
            ) : item.abstract ? (
                <DetailsSection title="Abstract">{item.abstract.trim()}</DetailsSection>
            ) : null}
            {mesh.length > 0 && (
                <DetailsSection
                    title="MeSH terms"
                    aside={(
                        <Tooltip content={MESH_HELP}>
                            <span className="font-color-secondary text-sm cursor-default">What are these?</span>
                        </Tooltip>
                    )}
                >
                    <MeshTerms terms={mesh} />
                </DetailsSection>
            )}
        </DetailsFrame>
    );
};

export default PubMedReferenceDetails;
