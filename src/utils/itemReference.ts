/**
 * A one-line bibliographic reference for a Zotero item, built from field reads.
 *
 * This is the `formatted_citation` Beaver surfaces show: citation tooltips,
 * the cited-sources list, and the reference attached to a resolved citation.
 * It pairs with `getItemDisplayName` (the headline) and `getItemDescription`
 * (a picker's second line); this is the fuller, citation-shaped string.
 *
 * Not the CSL engine: `CitationService.formatBibliography()` follows the
 * user's citation style but runs synchronously on the main thread, which
 * stalls a page of results. Everything here is `getField` reads and one
 * `getCreators()` call on data the callers have already loaded. The shape is
 * fixed and close to author-date; note-export and bibliography paths still
 * go through CSL. Never emits a URL or DOI.
 */

import { stripBidiIsolates } from './itemDisplayName';

/**
 * Item types cited by title rather than by creator.
 *
 * A bill's creator is its sponsor and a hearing's is a witness, so leading
 * with one produces nonsense. Every CSL style cites these by title.
 */
const TITLE_LED_TYPES: ReadonlySet<string> = new Set([
    'case',
    'statute',
    'bill',
    'hearing',
]);

/**
 * Item types whose series is the work a reader recognizes.
 *
 * Without this, {@link VENUE_FIELDS} reaches `publisher` first and the series
 * is lost.
 */
const SERIES_LED_TYPES: ReadonlySet<string> = new Set([
    'podcast',
    'radioBroadcast',
    'tvBroadcast',
    'videoRecording',
    'audioRecording',
]);

/**
 * Candidate fields for the item's venue — "where did this appear?" — in
 * priority order, first non-empty wins.
 *
 * Read base-mapped, so one entry covers every type-specific field Zotero maps
 * onto it. `organization` precedes `committee` so a standard is placed by its
 * body rather than its drafting subcommittee; hearings have no `organization`
 * field, so they still resolve to the committee.
 */
const VENUE_FIELDS: readonly string[] = [
    'publicationTitle', // base: journal, book section, proceedings, website, blog, encyclopedia, dictionary, forum, program
    'court',            // case
    'code',             // statute, bill
    'issuingAuthority', // patent
    'organization',     // standard
    'committee',        // hearing, standard
    'legislativeBody',  // bill, hearing
    'meetingName',      // presentation, conference paper
    'reporter',         // case, when it has no court
    'publisher',        // base: book, thesis, report, preprint, film, software, recordings, map, manuscript, dataset
    'seriesTitle',      // report, map, computerProgram, podcast, recordings
    'series',           // thesis, preprint, presentation
];

/**
 * Last-resort context when nothing bibliographic resolves: the medium
 * ("Oil on canvas") rather than the localized type name.
 */
const MEDIUM_FIELDS: readonly string[] = [
    'artworkMedium',
    'audioRecordingFormat',
    'videoRecordingFormat',
    'interviewMedium',
];

/** Creators listed in full before the list is cut to "et al.". */
const MAX_CREATORS = 3;

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

/** Localized item type name ("Patent", "Legal Case"). */
function itemTypeLabel(item: Zotero.Item): string {
    try {
        return Zotero.ItemTypes.getLocalizedString(item.itemType) || '';
    } catch {
        return '';
    }
}

/** A creator reduced to what the reference prints. */
interface CreatorName {
    last: string;
    first: string;
    /** Zotero's single-field mode: an institution, stored whole in `lastName`. */
    single: boolean;
}

/**
 * The creators a reference should name.
 *
 * Mirrors the fallback chain behind `item.firstCreator` (primary type, then
 * editor, then director, then contributor) so an edited volume is named by
 * its editors, and returns the whole set rather than Zotero's "Smith et al."
 * Also tries `author` after the primary type: a custom item type can report
 * no primary creator, and leaving authors unread would drop every name.
 */
function creatorNames(item: Zotero.Item): CreatorName[] {
    let creators: _ZoteroTypes.Item.Creator[];
    try {
        creators = item.getCreators() || [];
    } catch {
        return [];
    }
    if (creators.length === 0) return [];

    const chain: number[] = [];
    try {
        const primary = Zotero.CreatorTypes.getPrimaryIDForType(item.itemTypeID);
        if (primary !== false) chain.push(primary);
    } catch {
        // No primary type for this item type; the named fallbacks still apply.
    }
    for (const name of ['author', 'editor', 'director', 'contributor']) {
        try {
            const id = Zotero.CreatorTypes.getID(name);
            if (id !== false) chain.push(id as number);
        } catch {
            // Unknown creator type on this Zotero build; skip it.
        }
    }

    for (const creatorTypeID of chain) {
        const matches = creators.filter(c => (c.creatorTypeID as number) === creatorTypeID);
        if (matches.length > 0) {
            return matches
                .map(c => ({
                    last: stripBidiIsolates(c.lastName || '').trim(),
                    first: stripBidiIsolates(c.firstName || '').trim(),
                    single: c.fieldMode === 1,
                }))
                .filter(c => c.last || c.first);
        }
    }
    return [];
}

/** "Legewie, Joscha" — or the whole institution name in single-field mode. */
function formatCreator(creator: CreatorName): string {
    if (creator.single || !creator.first) return creator.last || creator.first;
    return `${creator.last}, ${creator.first}`;
}

/**
 * Join creators into the head of a reference.
 *
 * Entries are separated by semicolons because each already contains a comma.
 */
function formatCreatorList(creators: CreatorName[]): string {
    const names = creators.map(formatCreator).filter(Boolean);
    if (names.length === 0) return '';
    if (names.length === 1) return names[0];
    if (names.length > MAX_CREATORS) {
        return `${names.slice(0, MAX_CREATORS).join('; ')}; et al.`;
    }
    return `${names.slice(0, -1).join('; ')}; and ${names[names.length - 1]}`;
}

/**
 * The title to cite.
 *
 * For legal materials Zotero synthesizes a display title that folds in the
 * creator ("Test case (Smith)"), which collides with the year appended here.
 * The base-mapped `title` field is the real name — and the only way to reach
 * a statute's `nameOfAct` or a case's `caseName`.
 */
function referenceTitle(item: Zotero.Item): string {
    if (TITLE_LED_TYPES.has(item.itemType)) {
        const named = field(item, 'title');
        if (named) return named;
    }
    try {
        return item.getDisplayTitle?.() || field(item, 'title');
    } catch {
        return field(item, 'title');
    }
}

/** Publication year, base-mapped so `dateDecided` / `issueDate` also answer. */
function referenceYear(item: Zotero.Item): string {
    const match = field(item, 'date').match(/\d{4}/);
    return match ? match[0] : 'n.d.';
}

/** Reporter citation for a legal case ("410 U.S. 113"), kept as one unit. */
function caseReporterCitation(item: Zotero.Item): string {
    const reporter = field(item, 'reporter');
    if (!reporter) return '';
    return [field(item, 'reporterVolume'), reporter, field(item, 'firstPage')]
        .filter(Boolean)
        .join(' ');
}

/**
 * Everything after the title: where it appeared, and which one it is.
 *
 * Prefers a venue that repeats neither the title nor the creators, but falls
 * back to a repeat rather than dropping the venue — an institutional author
 * is often its own publisher.
 */
function referenceContext(item: Zotero.Item, title: string, creators: string): string[] {
    const normalize = (value: string) => value.trim().toLowerCase();
    const printed = new Set([title, creators].filter(Boolean).map(normalize));
    const parts: string[] = [];

    // Base-mapped type (thesisType, reportType, genre, …).
    const typeLabel = field(item, 'type');
    if (typeLabel) parts.push(typeLabel);

    // Reporter citation already consumes `reporter`.
    const reporterCitation = caseReporterCitation(item);
    let chain = reporterCitation ? VENUE_FIELDS.filter(name => name !== 'reporter') : VENUE_FIELDS;
    if (SERIES_LED_TYPES.has(item.itemType)) {
        chain = ['seriesTitle', ...chain.filter(name => name !== 'seriesTitle')];
    }

    let venue = '';
    let venueField = '';
    let repeat = '';
    let repeatField = '';
    for (const name of chain) {
        const value = field(item, name);
        if (!value) continue;
        if (!printed.has(normalize(value))) {
            venue = value;
            venueField = name;
            break;
        }
        if (!repeat) {
            repeat = value;
            repeatField = name;
        }
    }
    if (!venue && repeat) {
        venue = repeat;
        venueField = repeatField;
    }

    // Legal codes read volume-first ("167 Cong. Rec.").
    const codeVolume = venueField === 'code' ? field(item, 'codeVolume') : '';
    if (venue) {
        if (codeVolume) {
            parts.push(`${codeVolume} ${venue}`);
        } else {
            // Place only when the venue is the publisher, so a journal name
            // does not acquire "Journal: Cambridge, MA".
            const place = venueField === 'publisher' ? field(item, 'place') : '';
            parts.push(place ? `${venue}: ${place}` : venue);
        }
        // A chapter has both a container and a publisher.
        if (venueField === 'publicationTitle') {
            const publisher = field(item, 'publisher');
            if (publisher && !printed.has(normalize(publisher))) {
                const place = field(item, 'place');
                parts.push(place ? `${publisher}: ${place}` : publisher);
            }
        }
    }

    if (reporterCitation) {
        parts.push(reporterCitation);
    } else {
        // `codeVolume` already rode with the code above.
        const volume = codeVolume ? '' : firstField(item, ['volume', 'codeVolume']);
        const issue = field(item, 'issue');
        if (volume || issue) parts.push(issue ? `${volume}(${issue})` : volume);
    }

    const edition = field(item, 'edition');
    if (edition) parts.push(/\bed\b|\bedition\b/i.test(edition) ? edition : `${edition} ed.`);

    // Base-mapped identifier (patentNumber, reportNumber, …). Labelled so a
    // bare number next to a volume is not ambiguous.
    const number = field(item, 'number');
    if (number) parts.push(`No. ${number}`);

    const version = field(item, 'versionNumber');
    if (version) parts.push(`v${version.replace(/^[vV]\.?\s*/, '')}`);

    // A case's first page is already inside the reporter citation.
    if (!reporterCitation) {
        const pages = firstField(item, ['pages', 'codePages']);
        if (pages) parts.push(pages);
    }

    if (parts.length === 0) {
        const medium = firstField(item, MEDIUM_FIELDS);
        parts.push(medium || itemTypeLabel(item));
    }

    // Drop repeats of the title. A venue matching the creators was allowed
    // through on purpose; malformed records also store one value twice.
    const seen = new Set(title ? [normalize(title)] : []);
    return parts.filter(part => {
        if (!part) return false;
        const key = normalize(part.replace(/^No\. /, ''));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Terminate a segment, unless it already ends in sentence punctuation. */
function terminate(text: string): string {
    return /[.?!]$/.test(text) ? text : `${text}.`;
}

/**
 * Format a one-line bibliographic reference for an item.
 *
 * Shaped "Creators (Year). Title. Venue, volume(issue), pages." — or
 * "Title (Year). Venue, …" for legal materials and items with no creators.
 * Never emits a URL or DOI. Callers must have loaded `itemData` and `creators`.
 */
export function formatItemReference(item: Zotero.Item): string {
    const title = referenceTitle(item);
    const year = referenceYear(item);
    const creators = formatCreatorList(creatorNames(item));
    const context = referenceContext(item, title, creators).join(', ');

    const segments: string[] = [];
    if (creators && !TITLE_LED_TYPES.has(item.itemType)) {
        segments.push(`${creators} (${year}).`);
        if (title) segments.push(terminate(title));
    } else if (title) {
        // Year rides with the title so an abbreviation-final title stays intact.
        segments.push(`${title} (${year}).`);
    } else {
        segments.push(`(${year}).`);
    }
    if (context) segments.push(terminate(context));

    return segments.join(' ').trim();
}
