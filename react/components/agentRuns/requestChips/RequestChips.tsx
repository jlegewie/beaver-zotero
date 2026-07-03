import React from 'react';
import type { BeaverAgentPrompt } from '../../../agents/types';
import {
    chipForMessageAttachment,
    CollectionChip,
    LibraryChip,
    TagChip,
} from './RequestChipPrimitives';

const EMPTY_ATTACHMENTS: NonNullable<BeaverAgentPrompt['attachments']> = [];

export function RequestChips({ userPrompt }: { userPrompt: BeaverAgentPrompt }) {
    const attachments = userPrompt.attachments ?? EMPTY_ATTACHMENTS;

    return (
        <div className="display-flex flex-wrap gap-col-3 gap-row-2 mb-2">
            {userPrompt.filters?.libraries?.map((library) => (
                <LibraryChip
                    key={library.library_id}
                    libraryId={library.library_id}
                    name={library.name}
                />
            ))}
            {userPrompt.filters?.collections?.map((collection) => (
                <CollectionChip
                    key={`${collection.library_id}-${collection.zotero_key}`}
                    name={collection.name}
                    collectionRef={{ library_id: collection.library_id, zotero_key: collection.zotero_key }}
                    isFilter={true}
                />
            ))}
            {userPrompt.filters?.tags?.map((tag) => (
                <TagChip key={`${tag.libraryId}-${tag.id}-${tag.tag}`} tag={tag.tag} color={tag.color} />
            ))}
            {attachments.map((att, index) => chipForMessageAttachment(att, `attachment-${index}`))}
        </div>
    );
}
