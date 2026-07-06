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

/**
 * Curated follow-ups for the empty-library discovery flow.
 */
export const EMPTY_LIBRARY_DISCOVER_FOLLOWUPS: FirstRunFollowup[] = [
    {
        id: 'save_top_to_collection',
        title: 'Save the top results to a new collection',
        prompt: 'Create a new Zotero collection for this research and save the top results into it. Pick a clear, descriptive name for the collection.',
    },
    {
        id: 'synthesis_note',
        title: 'Create a summary note with key findings',
        prompt: 'Write a Zotero note that summarizes the key findings, methods, and open questions across the top results above. Group related papers together, use short section headings, and cite each paper referenced. Save the note to my library.',
    },
];

// ---------------------------------------------------------------------------
// Shared follow-ups reused across the suggestion-card and "Where should we
// start?" surfaces. Kept as named constants so both records stay in sync.
// ---------------------------------------------------------------------------
const RELATED_IN_LIBRARY: FirstRunFollowup = {
    id: 'related_in_library',
    title: 'Find related papers in my library',
    prompt: 'Find papers in my library related to this one. Briefly compare their findings and methodology.',
};

const FIND_RELATED_ONLINE: FirstRunFollowup = {
    id: 'find_recent_external',
    title: 'Find related papers online',
    prompt: 'Use external search to find recent papers on the topic of this paper. Prefer the last 5 years and highly-cited work. Return up to 8 results, each with title, first author, year, citation count, and a brief description of how it relates to this paper.',
};

const SAVE_TOP_TO_COLLECTION: FirstRunFollowup = {
    id: 'save_top_to_collection',
    title: 'Save the top results to a new collection',
    prompt: "Create a new collection for this research and add the top 5 results that are not already in my library. Also add relevant papers from my existing library to the new collection, so the collection has both new and known work side by side.",
};

const COMPARE_TO_LIBRARY: FirstRunFollowup = {
    id: 'compare_to_library',
    title: 'Compare these to research in my library',
    prompt: 'For the top results above, briefly compare how each relates to or extends the work already in my library on this topic.',
    promptWithTopic: 'For the top results above, briefly compare how each relates to or extends the work already in my library on {topic}.',
};

export const FIRST_RUN_FOLLOWUPS: Record<CardKind, FirstRunFollowup[]> = {
    reading_assistant: [
        {
            id: 'skim_with_highlights',
            title: 'Skim this paper with highlights',
            prompt: 'Help me skim this paper. Use highlight annotations to mark the key passages I should read to get the gist: the central argument and contribution, data and methods, main findings, and key conclusions. Aim for 6-10 short highlights in the main body of the paper. Be selective: together they should be the shortest path to understanding what the paper says.',
        },
        RELATED_IN_LIBRARY,
        FIND_RELATED_ONLINE,
    ],
    skim_paper: [
        {
            id: 'save_summary_note',
            title: 'Save this summary as a note',
            prompt: 'Slightly extend the summary above and save it as a Zotero note attached to this paper.',
        },
        RELATED_IN_LIBRARY,
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
        SAVE_TOP_TO_COLLECTION,
        COMPARE_TO_LIBRARY,
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

/**
 * Follow-ups for the "Where should we start?" launcher, keyed by the launched
 * built-in action id (mirrors the ids in `react/atoms/whereToStart.ts`).
 */
export const WHERE_TO_START_FOLLOWUPS: Record<string, FirstRunFollowup[]> = {
    // Start a research project — created a collection and populated it.
    'builtin-start-project': [
        {
            id: 'project_overview_note',
            title: 'Write an overview note for this project',
            prompt: 'Write a Zotero note giving a high-level overview of the literature in this project: the main themes, key findings, and open questions. Use sections to group related papers together, support every substantive claim with citations to specific passages from papers in the collection, and save the note into the project collection.',
        },
        {
            id: 'organize_into_sub_collections',
            title: 'Organize into sub-collections',
            prompt: 'Propose and create a small number of sub-collections for the items in this collection. The sub-collections should reflect how the material would actually be used for my project, not just surface keywords. Sort the items into the new sub-collection and provide a brief summary of each new sub-collection.',
        },
        {
            id: 'discover_more_external',
            title: 'Find more recent research on this topic',
            titleWithTopic: 'Find more recent research on {topic}',
            prompt: 'Use external search to find even more recent papers on this project\'s topic that are not already in the collection. Your search should be extremely broad and cover many angles to ensure full coverage. Import relevant papers and add them to my new collection. Provide a high-level overview of what you found and why it is relevant to my project.',
        },
    ],
    // Color-code a paper — highlights are in place.
    'builtin-color-code': [
        {
            id: 'summarize_in_note',
            title: 'Summarize this paper in a note',
            prompt: 'Write a Zotero note that summarizes this paper: its research question, methods, key findings, and limitations. Use the highlight annotations you just added as a guide, cite the specific highlighted passages, and save the note attached to this paper.',
        },
        RELATED_IN_LIBRARY,
        FIND_RELATED_ONLINE,
    ],
    // Tidy up the library — a first batch of filing/tagging/metadata is done.
    'builtin-tidy-up': [
        {
            id: 'continue_next_batch',
            title: 'Continue with the next batch',
            prompt: 'Continue tidying up the next batch of items using the same approach.',
        },
        {
            id: 'design_tag_vocabulary',
            title: 'Design a consistent tag vocabulary',
            prompt: 'Review the tags across my library and propose a small, consistent tag vocabulary. Merge near-duplicates and standardize casing.',
        },
    ],
    // Discover new research — presented a list, added nothing yet.
    'builtin-whats-new': [
        SAVE_TOP_TO_COLLECTION,
        COMPARE_TO_LIBRARY,
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

/**
 * Resolve the follow-up list for a given run. Empty-library runs get the
 * curated bootstrapping list regardless of `card_kind`; everything else
 * falls back to the per-card-kind list.
 */
export function getFollowupsForCardKind(
    cardKind: CardKind,
    emptyLibrary: boolean,
): FirstRunFollowup[] {
    if (emptyLibrary) return EMPTY_LIBRARY_DISCOVER_FOLLOWUPS;
    return FIRST_RUN_FOLLOWUPS[cardKind] ?? [];
}

/**
 * Resolve the follow-up list for a "Where should we start?" launcher run by the
 * launched built-in action id.
 */
export function getFollowupsForWhereToStart(actionId: string): FirstRunFollowup[] {
    return WHERE_TO_START_FOLLOWUPS[actionId] ?? [];
}

/**
 * Representative card kind per launcher action, kept client-side (not sent on
 * the where_to_start run origin). Used only to tag the `first_run_followup` run
 * a launcher follow-up spawns, so follow-up analytics align with the first-run
 * card kinds. Follow-up selection itself is keyed by action id, not this.
 */
const WHERE_TO_START_CARD_KIND: Record<string, CardKind> = {
    'builtin-start-project': 'literature_review',
    'builtin-color-code': 'reading_assistant',
    'builtin-tidy-up': 'organize_library',
    'builtin-whats-new': 'discover_research',
};

export function getWhereToStartCardKind(actionId: string): CardKind {
    return WHERE_TO_START_CARD_KIND[actionId] ?? 'discover_research';
}
