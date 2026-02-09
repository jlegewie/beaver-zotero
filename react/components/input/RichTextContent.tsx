import React, { useMemo } from 'react';
import InlineZoteroChip from './InlineZoteroChip';

type Segment =
    | { type: 'text'; value: string }
    | { type: 'reference'; libraryId: number; zoteroKey: string };

const ZOTERO_REF_REGEX = /@(\d+)-([A-Za-z0-9]{8})/g;

export function parseZoteroReferences(text: string): Segment[] {
    const segments: Segment[] = [];
    let lastIndex = 0;

    for (const match of text.matchAll(ZOTERO_REF_REGEX)) {
        const matchStart = match.index!;
        if (matchStart > lastIndex) {
            segments.push({ type: 'text', value: text.slice(lastIndex, matchStart) });
        }
        segments.push({
            type: 'reference',
            libraryId: parseInt(match[1], 10),
            zoteroKey: match[2],
        });
        lastIndex = matchStart + match[0].length;
    }

    if (lastIndex < text.length) {
        segments.push({ type: 'text', value: text.slice(lastIndex) });
    }

    return segments;
}

interface RichTextContentProps {
    text: string;
}

const RichTextContent: React.FC<RichTextContentProps> = ({ text }) => {
    const segments = useMemo(() => parseZoteroReferences(text), [text]);

    return (
        <>
            {segments.map((segment, index) => {
                if (segment.type === 'text') {
                    return <React.Fragment key={index}>{segment.value}</React.Fragment>;
                }
                return (
                    <InlineZoteroChip
                        key={index}
                        libraryId={segment.libraryId}
                        zoteroKey={segment.zoteroKey}
                    />
                );
            })}
        </>
    );
};

export default React.memo(RichTextContent);
