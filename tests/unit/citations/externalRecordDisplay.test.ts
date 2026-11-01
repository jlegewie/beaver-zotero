import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    citationLine,
    externalRecordLinks,
    externalRecordPresentation,
    formatRegistryDate,
    externalSourceLabel,
    isFreePmcArticle,
    primaryExternalUrl,
    publicationTypeBadges,
    trialEnrollmentLabel,
    trialHasProtocolOrSap,
    trialPhaseLabel,
    registryText,
    trialStatusDisplay,
} from '@beaver/agent-core/citations/externalRecordDisplay';
import {
    addExternalReferencesToMappingAtom,
    clearExternalReferenceCacheAtom,
    externalReferenceMappingAtom,
    formatExternalCitation,
    formatExternalReferenceLabel,
} from '@beaver/agent-core/citations/externalReferences';
import type { ExternalReference, TrialDetails } from '@beaver/agent-core/types/externalReferences';

const ref = (fields: Partial<ExternalReference> = {}): ExternalReference => ({
    source: 'pubmed',
    source_id: 'W4390000001',
    library_items: [],
    ...fields,
});

const trial = (details: Partial<TrialDetails> = {}): ExternalReference => ref({
    source: 'clinicaltrials',
    source_id: 'NCT03548935',
    item_type: 'report',
    url: 'https://clinicaltrials.gov/study/NCT03548935',
    zotero_fields: { reportNumber: 'NCT03548935', institution: 'clinicaltrials.gov' },
    details: { kind: 'trial', ...details },
});

describe('source labels and presentation', () => {
    it('labels known sources, including Crossref, and shows unknown ones raw', () => {
        expect(externalSourceLabel('crossref')).toBe('Crossref');
        expect(externalSourceLabel('clinicaltrials')).toBe('ClinicalTrials.gov');
        expect(externalSourceLabel('eric')).toBe('eric');
    });

    it('uses its own presentation for PubMed and trials and the generic card otherwise', () => {
        expect(externalRecordPresentation('pubmed')).toBe('pubmed');
        expect(externalRecordPresentation('clinicaltrials', trial())).toBe('trial');
        expect(externalRecordPresentation('openalex')).toBe('generic');
        expect(externalRecordPresentation('eric', ref({ details: { kind: 'webpage', site: 'x' } }))).toBe('generic');
    });

    it('falls back to the generic card for a trial record without trial details', () => {
        expect(externalRecordPresentation('clinicaltrials', ref({ source: 'clinicaltrials', details: { kind: 'future' } }))).toBe('generic');
    });
});

describe('links', () => {
    const work = ref({ identifiers: { pmid: '41234567', pmcid: 'PMC1', doi: '10.1056/x' } });

    it('derives PubMed, PMC, DOI and OpenAlex links from identifiers and the id', () => {
        expect(externalRecordLinks(work).map((link) => [link.kind, link.url])).toEqual([
            ['pubmed', 'https://pubmed.ncbi.nlm.nih.gov/41234567/'],
            ['pmc', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/'],
            ['doi', 'https://doi.org/10.1056/x'],
            ['openalex', 'https://openalex.org/W4390000001'],
        ]);
        expect(externalRecordLinks(trial()).map((link) => link.kind)).toEqual(['registry']);
    });

    it('follows the view source inside a search view and the identifiers elsewhere', () => {
        expect(primaryExternalUrl(work, 'pubmed')).toBe('https://pubmed.ncbi.nlm.nih.gov/41234567/');
        expect(primaryExternalUrl(work)).toBe('https://doi.org/10.1056/x');
        expect(primaryExternalUrl(ref({ source_id: 'pmid:42' }))).toBe('https://pubmed.ncbi.nlm.nih.gov/42/');
        expect(primaryExternalUrl(trial(), 'clinicaltrials')).toBe('https://clinicaltrials.gov/study/NCT03548935');
        expect(primaryExternalUrl(trial())).toBe('https://clinicaltrials.gov/study/NCT03548935');
        expect(primaryExternalUrl(ref({ source: 'openalex', url: 'https://x.org/a' }))).toBe('https://x.org/a');
    });
});

describe('works', () => {
    it('formats an NLM citation line', () => {
        expect(citationLine(ref({
            year: 2024,
            journal: { name: 'New England Journal of Medicine', volume: '390', issue: '9', pages: '801-812' },
            zotero_fields: { journalAbbreviation: 'N Engl J Med' },
        }))).toBe('N Engl J Med. 2024;390(9):801-812.');
        expect(citationLine(ref({ venue: 'Lancet', publication_date: '2023-01-05' }))).toBe('Lancet. 2023.');
        expect(citationLine(ref())).toBeNull();
    });

    it('badges notable PubMed publication types in display order', () => {
        expect(publicationTypeBadges(ref({
            raw_publication_types: ['Journal Article', 'Review', 'Randomized Controlled Trial', 'Systematic Review'],
        }))).toEqual(['Randomized Controlled Trial', 'Systematic Review', 'Review']);
    });

    it('shows Free PMC only when a PMCID exists and the article is free now', () => {
        const today = new Date(2026, 10, 2);
        expect(isFreePmcArticle(ref({ details: { kind: 'work', pmc_free_after: '2026-11-02' } }), today)).toBe(false);
        const pmc = { identifiers: { pmcid: 'PMC1' } };
        expect(isFreePmcArticle(ref({ ...pmc, details: { kind: 'work', pmc_free_after: '2026-11-02' } }), today)).toBe(true);
        expect(isFreePmcArticle(ref({ ...pmc, details: { kind: 'work', pmc_free_after: '2027-01-01' } }), today)).toBe(false);
        expect(isFreePmcArticle(ref(pmc), today)).toBe(false);
        expect(isFreePmcArticle(ref({ ...pmc, oa_candidates: [{ url: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/pdf' }] }), today)).toBe(true);
    });
});

describe('trials', () => {
    it('colors statuses as the registry does, with why_stopped on stopped trials', () => {
        expect(trialStatusDisplay({ kind: 'trial', status: 'RECRUITING' })).toMatchObject({ tone: 'green' });
        expect(trialStatusDisplay({ kind: 'trial', status: 'ENROLLING_BY_INVITATION' })).toMatchObject({ tone: 'blue' });
        expect(trialStatusDisplay({ kind: 'trial', status: 'COMPLETED' })).toMatchObject({ tone: 'grey' });
        expect(trialStatusDisplay({ kind: 'trial', status: 'TERMINATED', why_stopped: 'Funding' }))
            .toEqual({ label: 'Terminated', tone: 'red', hint: 'Funding' });
        expect(trialStatusDisplay({ kind: 'trial', status: 'UNKNOWN' })?.hint).toMatch(/not verified/);
        expect(trialStatusDisplay({ kind: 'trial', status: 'SOMETHING_NEW' })).toMatchObject({ label: 'Something new', tone: 'grey' });
    });

    it('removes the registry\'s markdown escapes for display', () => {
        expect(registryText('\\[stratified as 12-15 or \\>55\\] and 5\\.0')).toBe('[stratified as 12-15 or >55] and 5.0');
        expect(registryText('a \\\\ b')).toBe('a \\ b');
        expect(registryText('alpha \\& beta, 10\\^6 cells')).toBe('alpha & beta, 10^6 cells');
    });

    it('formats registry dates of any precision', () => {
        expect(formatRegistryDate('2020-04-29')).toBe('Apr 29, 2020');
        expect(formatRegistryDate('2020-04')).toBe('Apr 2020');
        expect(formatRegistryDate('2020')).toBe('2020');
        expect(formatRegistryDate(null)).toBeNull();
    });

    it('labels phases, enrollment and documents', () => {
        expect(trialPhaseLabel(['PHASE2', 'PHASE3'])).toBe('Phase 2/3');
        expect(trialPhaseLabel(['EARLY_PHASE1'])).toBe('Early Phase 1');
        expect(trialPhaseLabel(['NA'])).toBe('Phase N/A');
        expect(trialEnrollmentLabel({ kind: 'trial', enrollment_count: 1961, enrollment_type: 'ESTIMATED' }))
            .toBe('1,961 participants (est.)');
        expect(trialHasProtocolOrSap({ kind: 'trial', documents: [{ type_abbrev: 'ICF' }] })).toBe(false);
        expect(trialHasProtocolOrSap({ kind: 'trial', documents: [{ type_abbrev: 'Prot_SAP' }] })).toBe(true);
    });
});

describe('creators in labels and citations', () => {
    const creators = ref({
        authors: ['Novo Nordisk A/S'],
        creators: [
            { creatorType: 'author', name: 'Novo Nordisk A/S' },
            { creatorType: 'contributor', name: 'University of Oxford' },
        ],
        year: 2024,
        title: 'Semaglutide trial',
    });

    it('labels by author-role creators, keeping organizations whole', () => {
        expect(formatExternalReferenceLabel(creators)).toBe('Novo Nordisk A/S, 2024');
        expect(formatExternalReferenceLabel(ref({
            creators: [{ creatorType: 'author', firstName: 'Min', lastName: 'Lee' }, { creatorType: 'author', lastName: 'Garcia', firstName: 'Ana' }],
            year: 2024,
        }))).toBe('Lee et al., 2024');
    });

    it('falls back to parsing display names without creators', () => {
        expect(formatExternalReferenceLabel(ref({ authors: ['Ana Garcia'], year: 2020 }))).toBe('Garcia, 2020');
    });

    it('formats citations from creators', () => {
        expect(formatExternalCitation(creators)).toBe('Novo Nordisk A/S. 2024. "Semaglutide trial."');
        expect(formatExternalCitation(ref({
            creators: [{ creatorType: 'author', firstName: 'Min', lastName: 'Lee' }, { creatorType: 'author', firstName: 'Ana', lastName: 'Garcia' }],
            title: 'T',
        }))).toBe('Lee, Min and Ana Garcia. "T."');
        expect(formatExternalCitation(ref({ authors: ['A B', 'C D', 'E F', 'G H'], year: 2021 })))
            .toBe('B, A et al. 2021.');
    });
});

describe('addExternalReferencesToMappingAtom', () => {
    const pubmed = (at: string, title: string) => ref({ source: 'pubmed', retrieved_at: at, title, citation_count: 1 });
    const openalex = (at: string, count: number) => ref({ source: 'openalex', retrieved_at: at, citation_count: count, title: 'OpenAlex title' });

    it('keeps the combined record of a view\'s references and extra snapshots', () => {
        const store = createStore();
        store.set(addExternalReferencesToMappingAtom, [pubmed('2026-11-02T14:00:00Z', 'PubMed title'), openalex('2026-11-02T14:00:01Z', 812)]);
        expect(store.get(externalReferenceMappingAtom).W4390000001).toMatchObject({
            source: 'pubmed',
            title: 'PubMed title',
            citation_count: 812,
        });
    });

    it('gives the same records whatever order a thread replays its results in', () => {
        const snapshots = [
            pubmed('2026-11-02T14:00:00Z', 'Old PubMed'),
            openalex('2026-11-02T13:00:00Z', 5),
            pubmed('2026-11-02T15:00:00Z', 'New PubMed'),
            openalex('2026-11-02T16:00:00Z', 9),
        ];
        const replay = (order: ExternalReference[][]) => {
            const store = createStore();
            for (const batch of order) store.set(addExternalReferencesToMappingAtom, batch);
            return store.get(externalReferenceMappingAtom).W4390000001;
        };
        const forward = replay([[snapshots[0], snapshots[1]], [snapshots[2], snapshots[3]]]);
        const backward = replay([[snapshots[2], snapshots[3]], [snapshots[0], snapshots[1]]]);
        expect(forward).toEqual(backward);
        expect(forward).toMatchObject({ title: 'New PubMed', citation_count: 9 });
    });

    it('starts over after the cache is cleared', () => {
        const store = createStore();
        store.set(addExternalReferencesToMappingAtom, [pubmed('2026-11-02T15:00:00Z', 'New')]);
        store.set(clearExternalReferenceCacheAtom);
        store.set(addExternalReferencesToMappingAtom, [pubmed('2026-11-02T14:00:00Z', 'Old')]);
        expect(store.get(externalReferenceMappingAtom).W4390000001.title).toBe('Old');
    });
});
