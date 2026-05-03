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
            id: 'find_recent_external',
            title: 'Find related papers online',
            prompt: 'Use external search to find recent papers on the topic of this paper. Prefer the last 5 years and highly-cited work. Return up to 8 results, each with title, first author, year, citation count, and a brief description of how it relates to this paper.',
            
        },
    ],
    literature_review: [
        {
            id: 'discover_external',
            title: 'Find new research on this topic',
            titleWithTopic: 'Find new research on {topic}',
            prompt: 'Use external search to find recent papers on this topic that go beyond what I already have in my library. Briefly summarize and cite the most relevant papers including how they extend work in my library. Prefer the last 5 years and highly-cited work.',
        },
        {
            id: 'create_collection', // only if the lit review is NOT collection based!!!
            title: 'Organize items on this topic into a collection',
            titleWithTopic: 'Organize papers on {topic} into a collection',
            prompt: "Create a new collection for research on this topic. Move papers cited in the synthesis into the collection along with the synthesis note.",
        },
    ],
    discover_research: [
        {
            id: 'save_top_to_collection',
            title: 'Save the top results to a new collection',
            prompt: "Create a new collection for this research and add the top 5 results that are not already in my library. Also add relevant papers from my existing library to the new collection, so the collection has both new and known work side by side.",
        },
        {
            id: 'compare_to_library',
            title: 'Compare these to research in my library',
            prompt: 'For the top results above, briefly compare how each relates to or extends the work already in my library on this topic.',
            promptWithTopic: 'For the top results above, briefly compare how each relates to or extends the work already in my library on {topic}.',
        },
    ],
    organize_library: [
        // {
        //     id: 'next_batch',
        //     title: 'Continue with the next batch',
        //     prompt: 'Continue sorting the next 30 unfiled papers using the same approach.',
        // },
    ],
    organize_tags: [
        {
            id: 'approve_plan',
            title: 'Looks good, apply the plan',
            prompt: 'Looks good. Apply the plan as proposed.',
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
