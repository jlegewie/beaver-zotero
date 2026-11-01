/**
 * Source-agnostic presentation of external records: source labels, links
 * derived from identifiers and the id namespace, the primary link, badges,
 * the citation line, and trial registry fields. Pure; no client APIs.
 */

import type { ExternalReference, TrialDetails } from '../types/externalReferences';
import { trialDetails, workDetails } from '../types/externalReferences';
import { isOpenAlexWorkId, nctFromExternalId, pmidFromExternalId } from './externalRecords';

// =============================================================================
// Sources
// =============================================================================

const SOURCE_LABELS: Record<string, string> = {
    openalex: 'OpenAlex',
    pubmed: 'PubMed',
    clinicaltrials: 'ClinicalTrials.gov',
    openlibrary: 'Open Library',
    crossref: 'Crossref',
    semantic_scholar: 'Semantic Scholar',
    exa: 'Exa',
};

/** Display name of a source; an unknown source shows its raw string. */
export function externalSourceLabel(source: string | null | undefined): string {
    if (!source) return '';
    return SOURCE_LABELS[source] ?? source;
}

/** Which presentation a record (or a results view) gets. */
export type ExternalRecordPresentation = 'pubmed' | 'trial' | 'generic';

/**
 * The presentation for a source: PubMed and ClinicalTrials.gov have their own;
 * every other source uses the generic card. A trial presentation needs the
 * record's trial details, so a record without them falls back to generic.
 */
export function externalRecordPresentation(
    source: string | null | undefined,
    ref?: ExternalReference | null,
): ExternalRecordPresentation {
    if (source === 'pubmed') return 'pubmed';
    if (source === 'clinicaltrials') return ref && !trialDetails(ref) ? 'generic' : 'trial';
    return 'generic';
}

// =============================================================================
// Links
// =============================================================================

export function pubmedUrl(pmid: string): string {
    return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;
}

export function pmcUrl(pmcid: string): string {
    const id = /^pmc/i.test(pmcid) ? pmcid.toUpperCase() : `PMC${pmcid}`;
    return `https://pmc.ncbi.nlm.nih.gov/articles/${encodeURIComponent(id)}/`;
}

export function doiUrl(doi: string): string {
    return `https://doi.org/${doi}`;
}

export function trialRegistryUrl(nct: string): string {
    return `https://clinicaltrials.gov/study/${encodeURIComponent(nct.toUpperCase())}`;
}

export function openAlexWorkUrl(workId: string): string {
    return `https://openalex.org/${encodeURIComponent(workId)}`;
}

/** The record's PubMed id: its identifier, or the id of a `pmid:` record. */
export function recordPmid(ref: ExternalReference): string | null {
    const pmid = ref.identifiers?.pmid?.trim();
    return pmid || pmidFromExternalId(ref.source_id);
}

/** The record's NCT id: a trial's id, or the report number of a registry record. */
export function recordNct(ref: ExternalReference): string | null {
    const fromId = nctFromExternalId(ref.source_id);
    if (fromId) return fromId;
    const reportNumber = ref.zotero_fields?.reportNumber;
    return trialDetails(ref) ? nctFromExternalId(reportNumber) : null;
}

export interface ExternalRecordLink {
    kind: 'pubmed' | 'pmc' | 'doi' | 'registry' | 'openalex';
    label: string;
    url: string;
}

/** Links derived from a record's identifiers and id namespace, in display order. */
export function externalRecordLinks(ref: ExternalReference): ExternalRecordLink[] {
    const links: ExternalRecordLink[] = [];
    const pmid = recordPmid(ref);
    if (pmid) links.push({ kind: 'pubmed', label: 'PubMed', url: pubmedUrl(pmid) });
    const pmcid = ref.identifiers?.pmcid?.trim();
    if (pmcid) links.push({ kind: 'pmc', label: 'PubMed Central', url: pmcUrl(pmcid) });
    const doi = ref.identifiers?.doi?.trim();
    if (doi) links.push({ kind: 'doi', label: 'Publisher', url: doiUrl(doi) });
    const nct = recordNct(ref);
    if (nct) links.push({ kind: 'registry', label: 'ClinicalTrials.gov', url: trialRegistryUrl(nct) });
    if (ref.source_id && isOpenAlexWorkId(ref.source_id)) {
        links.push({ kind: 'openalex', label: 'OpenAlex', url: openAlexWorkUrl(ref.source_id) });
    }
    return links;
}

/**
 * The link a record's title and Web button open.
 *
 * Inside a search view it follows the view's source (the PubMed page in a
 * PubMed search, the registry page in a trial search). Elsewhere it follows
 * the identifiers: DOI, then PubMed, then the registry, then the record URL.
 */
export function primaryExternalUrl(ref: ExternalReference, viewSource?: string | null): string | undefined {
    const pmid = recordPmid(ref);
    const nct = recordNct(ref);
    if (viewSource === 'pubmed' && pmid) return pubmedUrl(pmid);
    if (viewSource === 'clinicaltrials' && nct) return trialRegistryUrl(nct);
    const doi = ref.identifiers?.doi?.trim();
    if (doi) return doiUrl(doi);
    if (pmid) return pubmedUrl(pmid);
    if (nct) return trialRegistryUrl(nct);
    return ref.url || ref.publication_url || ref.open_access_url || undefined;
}

// =============================================================================
// Works
// =============================================================================

function yearOf(ref: ExternalReference): string | undefined {
    if (ref.year != null) return String(ref.year);
    return ref.publication_date?.match(/^\d{4}/)?.[0];
}

/** NLM-style citation line: "N Engl J Med. 2024;390(9):801-812." Null without a journal. */
export function citationLine(ref: ExternalReference): string | null {
    const journal = ref.zotero_fields?.journalAbbreviation || ref.journal?.name || ref.venue;
    if (!journal) return null;
    const year = yearOf(ref);
    const volume = ref.journal?.volume;
    const issue = ref.journal?.issue;
    const pages = ref.journal?.pages;
    let line = journal.replace(/\.$/, '') + '.';
    if (year) {
        line += ` ${year}`;
        if (volume || issue) line += `;${volume ?? ''}${issue ? `(${issue})` : ''}`;
        if (pages) line += `:${pages}`;
        line += '.';
    }
    return line;
}

/** Publication types worth a badge, in display order (PubMed's names). */
const BADGE_PUBLICATION_TYPES = [
    'Randomized Controlled Trial',
    'Meta-Analysis',
    'Systematic Review',
    'Review',
    'Practice Guideline',
];

/** Badges for the record's notable publication types. */
export function publicationTypeBadges(ref: ExternalReference): string[] {
    const raw = new Set(ref.raw_publication_types ?? []);
    return BADGE_PUBLICATION_TYPES.filter((type) => raw.has(type));
}

const PMC_HOST = /(^|\.)(ncbi\.nlm\.nih\.gov\/pmc|pmc\.ncbi\.nlm\.nih\.gov|europepmc\.org)/i;

function isPmcLocation(candidate: { url?: string | null; page_url?: string | null; source_name?: string | null }): boolean {
    const urls = [candidate.url, candidate.page_url].filter((url): url is string => !!url);
    if (urls.some((url) => PMC_HOST.test(url.replace(/^https?:\/\//i, '')))) return true;
    return /pubmed central|europe pmc/i.test(candidate.source_name ?? '');
}

/** Today's date as YYYY-MM-DD in local time. */
function localIsoDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Whether the article is free in PMC now: it has a PMCID and either its PMC
 * release date has passed or OpenAlex lists a free PMC location. A PMCID
 * alone may still be under embargo.
 */
export function isFreePmcArticle(ref: ExternalReference, today: Date = new Date()): boolean {
    if (!ref.identifiers?.pmcid) return false;
    const releasedOn = workDetails(ref)?.pmc_free_after;
    if (releasedOn && releasedOn.slice(0, 10) <= localIsoDate(today)) return true;
    return (ref.oa_candidates ?? []).some(isPmcLocation);
}

// =============================================================================
// Trials
// =============================================================================

export type TrialStatusTone = 'green' | 'blue' | 'grey' | 'red';

export interface TrialStatusDisplay {
    label: string;
    tone: TrialStatusTone;
    /** Why the trial stopped, or that an unknown status is unverified. */
    hint?: string;
}

const TRIAL_STATUS: Record<string, { label: string; tone: TrialStatusTone }> = {
    RECRUITING: { label: 'Recruiting', tone: 'green' },
    NOT_YET_RECRUITING: { label: 'Not yet recruiting', tone: 'green' },
    ACTIVE_NOT_RECRUITING: { label: 'Active, not recruiting', tone: 'blue' },
    ENROLLING_BY_INVITATION: { label: 'Enrolling by invitation', tone: 'blue' },
    COMPLETED: { label: 'Completed', tone: 'grey' },
    TERMINATED: { label: 'Terminated', tone: 'red' },
    WITHDRAWN: { label: 'Withdrawn', tone: 'red' },
    SUSPENDED: { label: 'Suspended', tone: 'red' },
    UNKNOWN: { label: 'Unknown status', tone: 'grey' },
};

function humanizeEnum(value: string): string {
    const spaced = value.replace(/_/g, ' ').toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The registry status as a badge, or null without a status. */
export function trialStatusDisplay(details: TrialDetails): TrialStatusDisplay | null {
    const status = details.status?.trim();
    if (!status) return null;
    const key = status.toUpperCase();
    const known = TRIAL_STATUS[key];
    const display: TrialStatusDisplay = known ? { ...known } : { label: humanizeEnum(status), tone: 'grey' };
    if (display.tone === 'red' && details.why_stopped) display.hint = details.why_stopped;
    if (key === 'UNKNOWN') display.hint = 'Status not verified by the sponsor recently';
    return display;
}

/** "Phase 2/3", "Early Phase 1", "Phase N/A"; null without phases. */
export function trialPhaseLabel(phases: string[] | null | undefined): string | null {
    const values = (phases ?? []).filter(Boolean).map((phase) => phase.toUpperCase());
    if (!values.length) return null;
    if (values.every((phase) => phase === 'NA')) return 'Phase N/A';
    const numbers = values
        .map((phase) => /^PHASE(\d)$/.exec(phase)?.[1])
        .filter((value): value is string => !!value);
    const early = values.includes('EARLY_PHASE1');
    const parts: string[] = [];
    if (early) parts.push('Early Phase 1');
    if (numbers.length) parts.push(`Phase ${numbers.join('/')}`);
    return parts.length ? parts.join(', ') : values.map(humanizeEnum).join(', ');
}

/** "Interventional", "Observational", ...; null when unset. */
export function trialStudyTypeLabel(studyType: string | null | undefined): string | null {
    return studyType ? humanizeEnum(studyType) : null;
}

/** "1,961 participants" or "500 participants (est.)"; null without a count. */
export function trialEnrollmentLabel(details: TrialDetails): string | null {
    if (details.enrollment_count == null) return null;
    const count = details.enrollment_count.toLocaleString('en-US');
    const noun = details.enrollment_count === 1 ? 'participant' : 'participants';
    const estimated = details.enrollment_type?.toUpperCase() === 'ESTIMATED' ? ' (est.)' : '';
    return `${count} ${noun}${estimated}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A registry date for display: "2020-04-29" → "Apr 29, 2020", "2020-04" → "Apr 2020". */
export function formatRegistryDate(value: string | null | undefined): string | null {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value.trim());
    if (!match) return value;
    const month = MONTHS[Number(match[2]) - 1];
    if (!month) return value;
    return match[3] ? `${month} ${Number(match[3])}, ${match[1]}` : `${month} ${match[1]}`;
}

/** "Phase 2/3 · Interventional · 500 participants (est.)": the design at a glance; empty when unknown. */
export function trialDesignLine(details: TrialDetails): string {
    return [trialPhaseLabel(details.phases), trialStudyTypeLabel(details.study_type), trialEnrollmentLabel(details)]
        .filter(Boolean)
        .join(' · ');
}

/** Whether the registry lists a protocol or a statistical analysis plan. */
export function trialHasProtocolOrSap(details: TrialDetails): boolean {
    return (details.documents ?? []).some((document) => /(^|_)(prot|sap)(_|$)/i.test(document.type_abbrev ?? ''));
}

/** A trial's headline: its brief title, else the record title. */
export function trialHeadline(ref: ExternalReference): string {
    return trialDetails(ref)?.brief_title || ref.title || ref.source_id || 'Untitled trial';
}

/**
 * Registry text for display: ClinicalTrials.gov writes its free text as
 * markdown, escaping punctuation ("\\[", "\\>"); the escapes are removed.
 */
export function registryText(text: string): string {
    return text.replace(/\\([\\`*_{}[\]()#+\-.!<>|~])/g, '$1');
}

/** "Prot_SAP" → "Protocol and SAP" etc., for documents without a label. */
export function trialDocumentLabel(document: { type_abbrev?: string | null; label?: string | null }): string {
    if (document.label) return document.label;
    const parts = (document.type_abbrev ?? '').split('_').map((part) => ({
        PROT: 'Protocol', SAP: 'Statistical Analysis Plan', ICF: 'Informed Consent Form',
    }[part.toUpperCase()] ?? part));
    return parts.filter(Boolean).join(', ') || 'Document';
}
