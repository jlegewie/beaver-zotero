/**
 * Zotero-side constructor for the client-agnostic `MentionDescriptor` that the
 * composer's mention pills render from.
 *
 * The pill itself does no lookup: everything it shows is resolved here, once,
 * at insert time. Kept out of `zoteroReferences.ts` (the constructors for the
 * wire reference DTOs) because it pulls in the display helpers, which drag a
 * much larger import graph than that widely imported module should carry.
 */
import { truncateText } from '@beaver/agent-ui/utils/stringUtils';
import { getDisplayNameFromItem } from './sourceUtils';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';
import type { MentionDescriptor } from '../components/input/lexical/MentionNode';

/**
 * Labels are truncated here rather than in the pill: the client owns what a
 * short form of its own display name is, and the shared pill only has CSS
 * ellipsis to fall back on.
 */
const MAX_LABEL_LENGTH = 30;
const MAX_SUBLABEL_LENGTH = 40;

/** Build the descriptor for a mention pill standing in for a Zotero item. */
export function itemToMentionDescriptor(item: Zotero.Item): MentionDescriptor {
    const isRegularItem = item.isRegularItem();
    const label = truncateText(
        isRegularItem ? getDisplayNameFromItem(item) : item.getDisplayTitle(),
        MAX_LABEL_LENGTH,
    );

    // A regular item's label is "Creator Year", so the title genuinely
    // disambiguates two pills by the same author and year. For notes and
    // attachments the label already is the title, so there is nothing to add.
    const title = isRegularItem ? truncateText(item.getDisplayTitle(), MAX_SUBLABEL_LENGTH) : '';
    const sublabel = title && title !== label ? title : undefined;

    let iconName: string | undefined;
    try {
        iconName = item.getItemTypeIconName() ?? undefined;
    } catch {
        /* no icon - the pill falls back to a generic glyph */
    }

    return {
        label,
        ...(sublabel ? { sublabel } : {}),
        ...(iconName ? { iconName } : {}),
        ref: {
            library_id: item.libraryID,
            zotero_key: item.key,
            library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
        },
    };
}
