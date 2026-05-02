import { CardKind } from './librarySuggestions';

export interface FirstRunFollowup {
    id: string;
    title: string;
    prompt: string;
    /**
     * Optional topic-anchored variants used when `topic_label` is non-empty.
     * Fall back to the base `title` / `prompt` when topic is missing so the
     * sentence reads naturally either way (rather than relying on placeholder
     * stripping, which leaves dangling "on " / "about " fragments).
     */
    titleWithTopic?: string;
    promptWithTopic?: string;
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
            titleWithTopic: 'Expand on the disagreements about {topic}',
            prompt: "Going deeper on the disagreements you identified above, explain each side's argument and supporting evidence.",
            promptWithTopic: "Going deeper on the disagreements about {topic} you identified above, explain each side's argument and supporting evidence.",
        },
        {
            id: 'methodology_comparison',
            title: 'Compare methodologies',
            titleWithTopic: 'Compare methods used to study {topic}',
            prompt: 'Add a section comparing the research methodologies used across these papers.',
            promptWithTopic: 'Add a section comparing the research methodologies used to study {topic} across these papers.',
        },
    ],
    discover_research: [
        {
            id: 'narrow_recent',
            title: 'Narrow to the last 2 years',
            titleWithTopic: 'Recent research on {topic} (last 2 years)',
            prompt: 'From the results above, keep only papers published in the last 2 years.',
            promptWithTopic: 'From the {topic} results above, keep only papers published in the last 2 years.',
        },
        {
            id: 'highly_cited',
            title: 'Show only highly-cited results',
            titleWithTopic: 'Highly-cited papers on {topic}',
            prompt: 'From the results above, keep only the most highly-cited papers.',
            promptWithTopic: 'From the {topic} results above, keep only the most highly-cited papers.',
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

function fillTemplate(
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

export function renderFollowupTemplate(
    text: string,
    topic?: string | null,
    collection?: string | null,
): string {
    return fillTemplate(text, topic, collection);
}

/**
 * Picks the topic-anchored variant when `topic` is non-empty (the lit-review
 * and discover-research cards always populate `topic_label`), otherwise falls
 * back to the base copy. Returns the rendered title and prompt together so
 * call sites don't have to repeat the variant-selection logic.
 */
export function renderFollowup(
    fu: FirstRunFollowup,
    topic?: string | null,
    collection?: string | null,
): { title: string; prompt: string } {
    const hasTopic = !!topic && topic.trim().length > 0;
    const titleSource = hasTopic && fu.titleWithTopic ? fu.titleWithTopic : fu.title;
    const promptSource = hasTopic && fu.promptWithTopic ? fu.promptWithTopic : fu.prompt;
    return {
        title: fillTemplate(titleSource, topic, collection),
        prompt: fillTemplate(promptSource, topic, collection),
    };
}
