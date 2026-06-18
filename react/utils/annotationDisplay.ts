import { ZOTERO_ICONS } from '../components/icons/ZoteroIcon';

export const ANNOTATION_TEXT_BY_TYPE: Record<string, string> = {
    highlight: 'Highlight',
    underline: 'Underline',
    note: 'Sticky Note',
    image: 'Area',
};

export const ANNOTATION_PREVIEW_TEXT_BY_TYPE: Record<string, string> = {
    highlight: 'Highlighted Text',
    underline: 'Underlined Text',
    note: 'Sticky Note',
    image: 'Selected Area',
};

export const ANNOTATION_ICON_BY_TYPE: Record<string, string> = {
    highlight: ZOTERO_ICONS.ANNOTATE_HIGHLIGHT,
    underline: ZOTERO_ICONS.ANNOTATE_UNDERLINE,
    note: ZOTERO_ICONS.ANNOTATION,
    text: ZOTERO_ICONS.ANNOTATE_TEXT,
    image: ZOTERO_ICONS.ANNOTATE_AREA,
};
