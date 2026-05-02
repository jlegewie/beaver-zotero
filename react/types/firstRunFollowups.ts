import { CardKind } from './librarySuggestions';

export interface FirstRunFollowup {
    id: string;
    title: string;
    prompt: string;
}

export const FIRST_RUN_FOLLOWUPS: Record<CardKind, FirstRunFollowup[]> = {
    reading_assistant: [
        {
            id: 'related_in_library',
            title: 'Find related papers in my library',
            prompt: 'Find papers in my library related to this one. Briefly compare their findings and methodology.',
        },
        {
            id: 'extract_citations',
            title: 'Extract key citations',
            prompt: 'Extract the key citations from this paper. For each, summarize how the paper uses it.',
        },
    ],
    literature_review: [
        {
            id: 'expand_disagreements',
            title: 'Expand on the disagreements',
            prompt: "Going deeper on the disagreements you identified above, explain each side's argument and supporting evidence.",
        },
        {
            id: 'methodology_comparison',
            title: 'Compare methodologies',
            prompt: 'Add a section comparing the research methodologies used across these papers.',
        },
    ],
    discover_research: [
        {
            id: 'narrow_recent',
            title: 'Narrow to the last 2 years',
            prompt: 'From the results above, keep only papers published in the last 2 years.',
        },
        {
            id: 'highly_cited',
            title: 'Show only highly-cited results',
            prompt: 'From the results above, keep only the most highly-cited papers.',
        },
    ],
    organize_library: [
        {
            id: 'next_batch',
            title: 'Continue with the next batch',
            prompt: 'Continue sorting the next 30 unfiled papers using the same approach.',
        },
    ],
    organize_tags: [
        {
            id: 'more_candidates',
            title: 'Show more merge candidates',
            prompt: 'Look for additional overlapping tags I could merge, beyond the ones you proposed above.',
        },
    ],
};

export function renderFollowupTemplate(
    text: string,
    topic?: string | null,
    collection?: string | null,
): string {
    return text
        .replace(/\{topic\}/g, topic ?? '')
        .replace(/\{collection\}/g, collection ?? '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}
