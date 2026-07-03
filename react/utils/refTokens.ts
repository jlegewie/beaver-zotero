/**
 * Render helpers for model-authored `<ref/>` tokens — inline Zotero entity
 * chips. Frontend twin of the backend `app/utils/ref_tags.py`.
 *
 * A `<ref/>` NAMES a Zotero object inline (a chip); it is distinct from a
 * `<citation/>`, which ATTRIBUTES a claim to a source and owns passage
 * locators + the bibliography. Wire text always arrives already rewritten to
 * `<ref id="rN"/>` with a `references` map, so this only handles that shape;
 * a missing map entry degrades to raw text and never throws.
 */
import type { MessageAttachment } from '../types/attachments/apiTypes';

const REF_TOKEN_REGEX = /<ref\s+id="([^"]+)"\s*\/>/g;

export type RefTokenSegment =
    | { type: 'text'; text: string }
    | { type: 'ref'; refId: string; attachment: MessageAttachment };

function displayNameForRef(att: MessageAttachment): string {
    switch (att.type) {
        case 'item':
            return att.item?.title || `${att.library_id}-${att.zotero_key}`;
        case 'source':
            return att.attachment?.title
                || att.attachment?.filename
                || att.parent_item?.title
                || `${att.library_id}-${att.zotero_key}`;
        case 'note':
            return att.title || `${att.library_id}-${att.zotero_key}`;
        case 'collection':
            return att.name || `${att.library_id}-${att.zotero_key}`;
        case 'annotation':
            return att.text || att.comment || `${att.library_id}-${att.zotero_key}`;
        case 'external_file':
            return att.filename;
        default:
            return '';
    }
}

export function splitContentByRefTokens(
    content: string,
    references: Record<string, MessageAttachment> = {},
): RefTokenSegment[] {
    const segments: RefTokenSegment[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    REF_TOKEN_REGEX.lastIndex = 0;

    while ((match = REF_TOKEN_REGEX.exec(content)) !== null) {
        if (match.index > lastIndex) {
            segments.push({ type: 'text', text: content.slice(lastIndex, match.index) });
        }
        const [rawToken, refId] = match;
        const attachment = references[refId];
        if (attachment) {
            segments.push({ type: 'ref', refId, attachment });
        } else {
            segments.push({ type: 'text', text: rawToken });
        }
        lastIndex = match.index + rawToken.length;
    }

    if (lastIndex < content.length) {
        segments.push({ type: 'text', text: content.slice(lastIndex) });
    }

    return segments.length ? segments : [{ type: 'text', text: content }];
}

export function flattenRefTokens(
    content: string,
    references: Record<string, MessageAttachment> = {},
): string {
    return splitContentByRefTokens(content, references)
        .map((segment) => segment.type === 'text' ? segment.text : displayNameForRef(segment.attachment))
        .join('');
}
