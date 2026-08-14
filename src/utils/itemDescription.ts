/**
 * The second line of an item's presentation: the context that tells two
 * similarly-labelled items apart, composed from Zotero's own fields.
 *
 * Pairs with `getItemDisplayName` — the display name is the headline
 * ("Legewie and DiPrete 2014"), this is the line under it. Both are computed
 * here, React-free, so the agent data provider can serve them to a client with
 * no local Zotero (the Word add-in) and every surface calls the same item the
 * same thing.
 *
 * **Why not a formatted citation.** A CSL bibliography entry says the same
 * thing, but rendering one costs a few hundred milliseconds *per item* — a
 * 20-row picker page spends seconds on it, on Zotero's main thread. Everything
 * below is plain `getField` reads. Zotero's own citation dialog builds its
 * second line the same way and for the same reason (see
 * `chrome/content/zotero/integration/citationDialog/helpers.mjs`).
 *
 * **How it generalizes past journal articles.** Zotero maps type-specific
 * fields onto a handful of *base fields*, so one read covers many item types:
 * `publicationTitle` also answers for bookTitle / proceedingsTitle /
 * websiteTitle / blogTitle / encyclopediaTitle / dictionaryTitle / forumTitle /
 * programTitle, and `publisher` for university (thesis), institution (report),
 * repository (preprint, dataset), company (computerProgram), distributor
 * (film), label (audioRecording), network (broadcasts), studio
 * (videoRecording). Reading those with `includeBaseMapped` is what keeps this
 * from being a journal-article formatter. The types Zotero does *not* base-map
 * — legal cases, statutes, bills, hearings, patents, standards — are named
 * explicitly in {@link VENUE_FIELDS}, and anything still unresolved falls back
 * to the localized item type name, so every item gets a usable line.
 */

/** Descriptions are truncated to this many characters by default. */
export const MAX_DESCRIPTION_LENGTH = 300;

/** Note previews are cut to this many characters. */
const NOTE_PREVIEW_LENGTH = 140;

import { noteHtmlToPlainText } from './noteHtml';
import { displayNameUsesTitle, getItemDisplayName } from './itemDisplayName';

function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
}

/**
 * Candidate fields for the item's venue — "where did this appear?" — in
 * priority order, first non-empty wins.
 *
 * Read with `includeBaseMapped`, so an entry stands for every type-specific
 * field Zotero maps onto it. The order runs most specific to most generic:
 * a hearing has a committee, a legislative body *and* a publisher, and the
 * committee is what identifies it.
 */
const VENUE_FIELDS: readonly string[] = [
    'publicationTitle', // base: journal, book section, proceedings, website, blog, encyclopedia, dictionary, forum, program
    'court',            // case
    'code',             // statute, bill
    'issuingAuthority', // patent
    'committee',        // hearing, standard
    'legislativeBody',  // bill, hearing
    'organization',     // standard
    'meetingName',      // presentation, conference paper
    'reporter',         // case, when it has no court
    'publisher',        // base: book, thesis, report, preprint, film, software, recordings, map, manuscript, dataset
    'seriesTitle',      // report, map, computerProgram
    'series',           // thesis, preprint, presentation
];

/** Read a field, base-mapped, and normalize whitespace. Never throws. */
function field(item: Zotero.Item, name: string): string {
    try {
        return (item.getField(name, false, true) || '').trim();
    } catch {
        return '';
    }
}

/** First non-empty of several fields. */
function firstField(item: Zotero.Item, names: readonly string[]): string {
    for (const name of names) {
        const value = field(item, name);
        if (value) return value;
    }
    return '';
}

/**
 * The reporter citation for a legal case ("410 U.S. 113").
 *
 * Built as one unit because its three fields are meaningless apart — a bare
 * volume "410" in a comma-separated list reads as noise.
 */
function caseReporterCitation(item: Zotero.Item): string {
    const reporter = field(item, 'reporter');
    if (!reporter) return '';
    const volume = field(item, 'reporterVolume');
    const firstPage = field(item, 'firstPage');
    return [volume, reporter, firstPage].filter(Boolean).join(' ');
}

/** Localized item type name ("Patent", "Legal Case"), the last-resort context. */
function itemTypeLabel(item: Zotero.Item): string {
    try {
        return Zotero.ItemTypes.getLocalizedString(item.itemType) || '';
    } catch {
        return '';
    }
}

/**
 * Context parts for a regular item, excluding the title.
 *
 * Order is "what kind of thing, published where, which one": a type label
 * ("Ph.D. Thesis"), the venue, then the coordinates that pick out this
 * particular item within it.
 */
function regularItemContext(item: Zotero.Item): string[] {
    const parts: string[] = [];

    // base: thesisType, reportType, genre, presentationType, manuscriptType,
    // mapType, postType, letterType, websiteType, plus literal `type` on
    // standard and dataset. Leads because it names the kind of thing.
    const typeLabel = field(item, 'type');
    if (typeLabel) parts.push(typeLabel);

    // A case's reporter citation consumes `reporter`, so the venue chain must
    // not also offer it — otherwise the same string lands twice.
    const reporterCitation = caseReporterCitation(item);
    const venueFields = reporterCitation
        ? VENUE_FIELDS.filter((name) => name !== 'reporter')
        : VENUE_FIELDS;

    let venue = '';
    let venueField = '';
    for (const name of venueFields) {
        const value = field(item, name);
        if (value) {
            venue = value;
            venueField = name;
            break;
        }
    }

    if (venue) {
        // "Harvard University Press: Cambridge" — the publisher idiom, applied
        // only when the venue really is the publisher, so a journal name does
        // not acquire a colon and the article's place of publication.
        const place = venueField === 'publisher' ? field(item, 'place') : '';
        parts.push(place ? `${venue}: ${place}` : venue);
    }

    if (reporterCitation) {
        parts.push(reporterCitation);
    } else {
        const volume = firstField(item, ['volume', 'codeVolume']);
        const issue = field(item, 'issue');
        if (volume || issue) {
            parts.push(issue ? `${volume}(${issue})` : volume);
        }
    }

    // base: patentNumber, docketNumber, reportNumber, billNumber,
    // publicLawNumber, documentNumber, archiveID, identifier, episodeNumber.
    // Labelled, because a bare identifier next to a volume is ambiguous.
    const number = field(item, 'number');
    if (number) parts.push(`No. ${number}`);

    // A case's first page is already inside the reporter citation.
    if (!reporterCitation) {
        const pages = firstField(item, ['pages', 'codePages']);
        if (pages) parts.push(pages);
    }

    if (parts.length === 0) {
        // Nothing bibliographic resolved. A URL at least says where it lives;
        // failing that, name the kind of thing, so the line is never empty.
        const url = field(item, 'url');
        if (url) parts.push(url);
        else {
            const label = itemTypeLabel(item);
            if (label) parts.push(label);
        }
    }

    return parts;
}

/**
 * Description for a note: the start of its content, minus the part already
 * used as its title.
 */
function noteDescription(item: Zotero.Item): string {
    try {
        const title = item.getNoteTitle();
        let text = noteHtmlToPlainText(item.getNote());
        if (title && text.startsWith(title)) {
            text = text.slice(title.length);
        }
        text = text.trim().replace(/\s+/g, ' ');
        if (text) return truncate(text, NOTE_PREVIEW_LENGTH);
    } catch {
        // Fall through to the relationship line.
    }
    return item.parentItem ? 'Attached note' : 'Standalone note';
}

/**
 * Description for an attachment: what it belongs to.
 *
 * An attachment's own title ("Accepted Version", "Full Text PDF") is the
 * display name and says nothing on its own, so the useful context is the
 * parent it hangs off.
 */
function attachmentDescription(item: Zotero.Item): string {
    try {
        const parent = item.parentItem;
        if (parent) return `Attached to ${getItemDisplayName(parent)}`;
    } catch {
        // The parent may not be loaded; fall back to the standalone wording.
    }
    return 'Standalone attachment';
}

/** Description for an annotation: its kind, and the attachment it sits in. */
function annotationDescription(item: Zotero.Item): string {
    const kind = itemTypeLabel(item) || 'Annotation';
    try {
        const parent = item.parentItem;
        // The annotation's parent is the attachment; its parent is the work,
        // which is the name a reader recognizes.
        const source = parent?.parentItem ?? parent;
        if (source) return `${kind} in ${getItemDisplayName(source)}`;
    } catch {
        // Fall through to the bare kind.
    }
    return kind;
}

export interface ItemDescriptionOptions {
    /**
     * Include the item's title. On by default, so the description stands alone
     * as the second line under a creator-and-year display name. Turn it off
     * where the title is already on screen.
     *
     * Ignored when the display name *is* the title (an item with no creators),
     * since repeating it would waste the line.
     */
    includeTitle?: boolean;
    /** Truncation length. Defaults to {@link MAX_DESCRIPTION_LENGTH}. */
    maxLength?: number;
}

/**
 * Describe an item in one line, to sit under {@link getItemDisplayName}.
 *
 * @param item - The item to describe.
 * @param options - See {@link ItemDescriptionOptions}.
 * @returns A single line, or '' when the item yields nothing at all.
 */
export function getItemDescription(
    item: Zotero.Item,
    options: ItemDescriptionOptions = {}
): string {
    const { includeTitle = true, maxLength = MAX_DESCRIPTION_LENGTH } = options;

    let description: string;

    if (item.isNote()) {
        description = noteDescription(item);
    } else if (item.isAnnotation()) {
        description = annotationDescription(item);
    } else if (item.isAttachment()) {
        description = attachmentDescription(item);
    } else {
        const parts = regularItemContext(item);
        // Repeating the headline would waste the line, so the title is dropped
        // whenever the display name already fell back to it.
        const wantTitle = includeTitle && !displayNameUsesTitle(item);
        const title = wantTitle ? field(item, 'title') : '';
        description = [title, ...parts].filter(Boolean).join(', ');
    }

    return truncate(description.trim(), maxLength);
}
