import { CardKind } from '@beaver/agent-core/types/librarySuggestions';

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

// ---------------------------------------------------------------------------
// Follow-ups shared by several launcher actions.
// ---------------------------------------------------------------------------
const RELATED_IN_LIBRARY: FirstRunFollowup = {
    id: 'related_in_library',
    title: 'Find related papers in my library',
    prompt: 'Find papers in my library related to this one. Briefly compare their findings and methodology.',
};

const FIND_RELATED_ONLINE: FirstRunFollowup = {
    id: 'find_recent_external',
    title: 'Find related papers online',
    prompt: 'Use external search to find recent papers on the topic of this paper. Prefer the last 5 years and highly-cited work. Return up to 8 results, each with title, first author, year, citation count, and a brief description of how it relates to this paper. If external search is not available, tell me I can switch to the Beaver model or enable Plus Tools in settings rather than substituting a search of my own library.',
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
            prompt: 'Use external search to find even more recent papers on this project\'s topic that are not already in the collection. Your search should be extremely broad and cover many angles to ensure full coverage. Import relevant papers and add them to my new collection. Provide a high-level overview of what you found and why it is relevant to my project. If external search is not available, tell me I can switch to the Beaver model or enable Plus Tools in settings, and do not import anything found by guessing identifiers.',
            promptWithTopic: 'Use external search to find even more recent papers on {topic} that are not already in the collection. Your search should be extremely broad and cover many angles to ensure full coverage. Import relevant papers and add them to my new collection. Provide a high-level overview of what you found and why it is relevant to my project. If external search is not available, tell me I can switch to the Beaver model or enable Plus Tools in settings, and do not import anything found by guessing identifiers.',
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

function fillTemplate(text: string, topic?: string | null): string {
    return text
        .replace(/\{topic\}/g, topic ?? '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Picks the topic-anchored variant when `topic` is non-empty, otherwise falls
 * back to the base copy. Returns the rendered title and prompt together so
 * call sites don't have to repeat the variant-selection logic.
 */
export function renderFollowup(
    fu: FirstRunFollowup,
    topic?: string | null,
): { title: string; prompt: string } {
    const hasTopic = !!topic && topic.trim().length > 0;
    const titleSource = hasTopic && fu.titleWithTopic ? fu.titleWithTopic : fu.title;
    const promptSource = hasTopic && fu.promptWithTopic ? fu.promptWithTopic : fu.prompt;
    return {
        title: fillTemplate(titleSource, topic),
        prompt: fillTemplate(promptSource, topic),
    };
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
 * a launcher follow-up spawns, which the run origin requires. Follow-up
 * selection itself is keyed by action id, not this.
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
