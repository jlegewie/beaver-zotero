import React from 'react';
import type { MessageAttachment } from '../../types/attachments/apiTypes';
import { splitContentByRefTokens } from '../../utils/refTokens';
import { inlineChipForMessageAttachment } from './requestChips/RequestChipPrimitives';

export function renderContentWithRefChips(
    content: string,
    references: Record<string, MessageAttachment> = {},
): React.ReactNode[] {
    return splitContentByRefTokens(content, references).map((segment, index) => {
        if (segment.type === 'text') {
            return <React.Fragment key={`text-${index}`}>{segment.text}</React.Fragment>;
        }
        return inlineChipForMessageAttachment(segment.attachment, `ref-${segment.refId}-${index}`);
    });
}
