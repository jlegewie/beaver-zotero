/**
 * Built-in actions — always shipped with the plugin.
 *
 * These are defined in code so they can be improved across updates without
 * being frozen by user edits. User overrides are stored separately in the
 * `beaver.actions` preference via ActionCustomizations.
 */

import { Action } from './actions';
import { ARCHIVED_ACTIONS } from './archivedActions';



/** Default built-in actions for Beaver. */
export const BUILTIN_ACTIONS: Action[] = [

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: items (single or multiple selected items)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-summarize',
        name: 'summarize',
        title: 'Summarize',
        text: 'Summarize the attached item(s) so I can quickly recall what each says and decide whether to read it in full.\n\nSteps:\n1. Understand the content of each attached document. For shorter articles, read the full document. For longer articles or books, use the extract tool to create a detailed summary. If the extract tool is not available, read relevant sections of the attached document. If multiple items are attached, handle each separately and write one note per item.\n2. Match the summary to the document type: for empirical papers cover the research question, data and methods, key findings, and conclusions; for theoretical or review work cover the aim, main arguments, and contribution; for books cover the purpose, structure, and central claims.\n3. Save each summary as a Zotero note attached to the item.\n\nFormat: 200-400 words with short bold section headings and prose under each (no bullet lists). Support every substantive claim with citations to specific passages in the document.\n\nIf no full text is available, base the summary on the abstract and metadata and say so at the top of the note. If my message names a specific focus, emphasize it.',
        argumentHint: 'Optional: what to focus on, e.g. methods or findings',
        targets: ['items', 'attachment'],
        category: 'write',
        sortOrder: 100,
    },

    {
        id: 'builtin-fit-research',
        name: 'fit-into-library',
        title: 'How does this fit into my library?',
        text: 'Show me how this paper relates to the rest of my library.\n\nSteps:\n1. Read the paper (or its abstract if no full text is available) to identify its core question, method, and main claims.\n2. Search my library from several angles — same topic, same method, same phenomenon — and read the most relevant matches closely enough to compare them honestly.\n3. Write the result as a Zotero note attached to the item.\n\nThe note should contain: a short paragraph positioning the paper within my library; what it builds on or supports, what it challenges or complicates, and what it extends; a comparison table (paper, relationship, key difference); and a closing sentence on what this paper adds that my library did not already have. Cite every library paper you mention.\n\nIf little in my library relates to it, say so directly instead of forcing weak connections, and note that this paper opens a new area for me. If multiple items are attached, handle each in turn.',
        argumentHint: 'Optional: what to compare, e.g. argument, method, or findings',
        targets: ['items', 'attachment'],
        category: 'research',
        sortOrder: 110,
    },

    {
        id: 'builtin-find-similar',
        name: 'find-similar',
        title: 'Find similar papers',
        text: 'Find papers closely related to this item using external search.\n\nSteps:\n1. Identify what makes this paper distinctive: its topic, method, data or population, and central claim.\n2. Run external searches from more than one of those angles so the results are not one-dimensional.\n3. Check which results are already in my library.\n\nFormat: a ranked list of up to 10 papers. For each, give authors (year), title, and one sentence on why it is relevant. Clearly mark the papers I already have, and cite the rest as external references so I can add them.\n\nIf the item has no abstract or full text, work from the title and metadata and say so. If my message names a specific kind of similarity (same method, same data, competing argument), prioritize it. If multiple items are attached, handle each separately.',
        argumentHint: 'Optional: similar how, e.g. method, data, or theory',
        targets: ['items', 'attachment'],
        category: 'research',
        sortOrder: 120,
    },

    {
        id: 'builtin-tag-items',
        name: 'auto-tag',
        title: 'Auto-tag',
        text: 'Assign tags to the attached items.\n\nSteps:\n1. Look at my existing tags first and reuse them wherever they fit, matching my style and level of granularity.\n2. Analyze each item (abstract, or full text when the abstract is not enough) and assign 2-5 subject tags covering the topic and, where clear, the method.\n3. Be consistent: items on the same subtopic must share the same tags. Create a new tag only when nothing existing fits, and keep new tags lowercase and 1-3 words.\n\nWhen done, show a table of items and their assigned tags, marking newly created tags so I can spot vocabulary drift.',
        targets: ['items'],
        category: 'organize',
        sortOrder: 140,
    },

    {
        id: 'builtin-sort-into-collections',
        name: 'sort-into-collections',
        title: 'Sort into collections',
        text: 'File the attached items into my existing collections.\n\nSteps:\n1. Review my collections (including sub-collections) to understand how my library is organized.\n2. Add each item to the collection or collections where it clearly belongs — the best one or two, not every plausible match. Never remove an item from a collection it is already in.\n3. If an item fits no existing collection, do not force it: list it separately and suggest a sensible new collection name for it.\n\nWhen done, show a table of items and where each was filed, with the no-fit items and suggested new collections at the end.',
        targets: ['items'],
        category: 'organize',
        sortOrder: 150,
    },

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: attachment (PDF/EPUB open in reader or selected)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-skim-paper',
        name: 'skim',
        title: 'Skim this paper',
        text: 'Help me skim this document by highlighting only what I need to read to get the gist.\n\nSteps:\n1. Read the document and find the passages that carry it: the central argument and contribution, the data and methods, the main findings, and the key conclusions. For non-empirical work (theory, review, book chapter), highlight the central claims, the key evidence they rest on, and the conclusions instead.\n2. Create 4-8 highlight annotations of 2-3 sentences each. Prefer the body of the document over the abstract and introduction, which I can skim myself. Be extremely selective — reading only the highlights should take a few minutes.\n3. End with a short structured summary: **Central argument and contribution** — 1-2 sentences citing the relevant highlights — then the same for **Data and methods**, **Main findings**, and **Conclusions**, adapting the headings if the document type requires it.\n\nIf my message names a specific focus, weight the highlights toward it.',
        argumentHint: 'Optional: what to focus on while skimming',
        targets: ['attachment'],
        category: 'annotate',
        sortOrder: 200,
    },

    {
        id: 'builtin-color-code',
        name: 'color-code',
        title: 'Color-code this paper',
        text: 'Color-code this document with highlight annotations so I can navigate it at a glance:\n- Yellow: the research question, aim, or central argument\n- Green: data and methods\n- Blue: main results and findings\n- Purple: limitations, caveats, and open questions\n\nIf the document has no empirical sections (theory, review, essay), adapt the legend — yellow for central claims, green for the evidence or literature supporting them, blue for implications, purple for limitations — and state the adapted legend in your summary. If my message specifies a different scheme, use mine.\n\nBe selective: highlight only short, high-signal passages (1-3 sentences each) in the main body, and skip background and literature review. Add a brief comment to each highlight noting what it captures.\n\nWhen finished, write a short summary organized by color: state the legend, then 1-2 sentences per color citing its annotations.',
        argumentHint: 'Optional: your own color scheme or focus',
        targets: ['attachment'],
        category: 'annotate',
        sortOrder: 210,
    },

    {
        id: 'builtin-extract-references',
        name: 'key-references',
        title: 'Find key references from this paper',
        text: 'Identify the references this paper most depends on, so I can decide what to read next.\n\nSteps:\n1. Read the paper and pick the 3-5 cited works that are genuinely load-bearing: foundational to its argument, the source of its method or data, or the main position it argues against. Judge by the role each reference plays in the text, not by how often it is cited.\n2. For each, explain in 1-2 sentences what role it plays in this paper.\n3. Search my library to check whether I already have each one. For the ones I am missing, find them with external search and cite them as external references so I can add them.\n\nFormat: a numbered list — reference, its role in the paper, and whether it is already in my library. If the bibliography is not readable (e.g. a scanned PDF), say so and work from the citations you can read in the text.',
        targets: ['attachment'],
        category: 'research',
        sortOrder: 230,
    },

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: collection (a collection is selected in sidebar)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-collection-gaps',
        name: 'find-gaps',
        title: 'What am I missing in this collection?',
        text: 'Analyze this collection and tell me what is missing.\n\nSteps:\n1. Survey the collection: the topics, methods, populations or cases, time periods, and perspectives it represents.\n2. Identify 2-4 specific gaps — subtopics, methods, or viewpoints that the collection\'s own scope implies but does not cover. Anchor each gap in what the collection is evidently about; do not invent adjacent topics.\n3. For each gap, use external search to find strong papers that would fill it. Also check whether good candidates are already in my library but outside this collection.\n\nFormat: organize by gap. For each, give 1-2 sentences on what is missing and why it matters, then the suggested papers (up to 8 total across all gaps), each with a one-sentence rationale, cited as external references. Mark any suggestion that is already elsewhere in my library.\n\nIf the collection is small (under about 5 items), say the analysis is provisional and interpret its scope generously.',
        argumentHint: 'Optional: what kind of gaps to look for',
        targets: ['collection'],
        category: 'research',
        sortOrder: 400,
    },

    {
        id: 'builtin-collection-literature-review',
        name: 'literature-review',
        title: 'Literature review outline',
        text: 'Create a literature review outline from the papers in this collection.\n\nSteps:\n1. Review every paper in the collection — abstracts for all of them, full text for the papers central to the debates you identify.\n2. Group the papers thematically, never chronologically or paper-by-paper. Identify the key debates, the points of consensus, and the open questions.\n3. Save the outline as a Zotero note in this collection.\n\nThe note should contain: a working title; a one-paragraph framing of the field; one section per theme with a heading, 3-5 sentences in prose on the state of that theme (who argues what and where the disagreement lies), and citations to the collection papers that belong there; and a closing section on the open questions the review should end on. Write in prose — no bullet points or numbered lists. Every paper in the collection should appear somewhere; if some genuinely fit no theme, list them at the end with a brief note on why.\n\nIf my message says what the review is for (a dissertation chapter, a paper introduction, a grant application), shape the outline to that purpose.',
        argumentHint: 'Optional: what the review is for, e.g. a paper intro or dissertation chapter',
        targets: ['collection'],
        category: 'write',
        sortOrder: 410,
    },

    {
        id: 'builtin-collection-organize-sub-collections',
        name: 'organize-sub-collections',
        title: 'Organize into thematic sub-collections',
        text: 'Organize the items in this collection into thematic sub-collections.\n\nSteps:\n1. Review the items and any existing sub-collections. Reuse existing sub-collections whenever they fit.\n2. Design a scheme of roughly 3-7 sub-collections with clear, mutually distinct themes and reasonably balanced sizes. Prefer themes that reflect how the material would actually be used, not surface keywords. If my message specifies an organizing principle (by method, by period, by debate), use it.\n3. Before changing anything, show me the proposed scheme — each sub-collection with an item count and 2-3 example items — and ask me to confirm or adjust it.\n4. Once I confirm, create the new sub-collections and add each item to the one where it belongs. Items that fit nowhere stay where they are — list them at the end rather than forcing them in.\n\nFinish with a summary of the final structure.',
        argumentHint: 'Optional: how to organize, e.g. by theme, method, or time period',
        targets: ['collection'],
        category: 'organize',
        sortOrder: 430,
    },

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: global (no specific context, library-wide)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-start-project',
        name: 'start-project',
        title: 'Start a research project',
        text: 'Set up a new research project in my library.\n\nSteps:\n1. Confirm the scope: restate the project topic in one sentence. If I did not name a topic, or it is too broad to search well, ask me a clarifying question before continuing.\n2. Create a new collection with a short, descriptive name for the project.\n3. Search my library from several angles for items relevant to the topic and add the clearly relevant ones to the new collection. Do not remove them from any other collection.\n4. If available as a tool, use 1-3 external topic searches to find important papers on the topic that are not yet in my library. Use the create_items tool to import the most relevant ones directly into the new collection.\n5. Close with a short, structured summary: the collection you created, how many existing items you added, and the key external papers you imported. Use bold formatting to clearly structure the short summary and make it readable to the user. End with suggestions for next steps such as "**Next step:** If you want, I can create a zotero note with a high-level overview of the relevant literature."',
        argumentHint: 'Name the project or research topic',
        targets: ['global'],
        category: 'research',
        sortOrder: 505,
    },

    {
        id: 'builtin-whats-new',
        name: 'discover',
        title: 'Discover new research',
        text: 'Find notable research I should know about in my area of interest.\n\nStep 1. Determine the focus: if I named a topic or question, use that. Otherwise, infer what I am currently working on from my most recent \nadditions. If there are multiple relevant topics, ask me to select from plausible choices.\n\nStep 2. Run 1-2 parallel topic searches in my own library to understand what I already have in my library.\n\nStep 3. Run 2-3 external topic searches to find notable work in this area outside of my library. Prioritize a mix of recent papers (last 2-3 \nyears) and influential work I appear to be missing. Return up to 8 papers not yet in my library ranked by relevance. For each, provide the \nauthors, publiation year, title, journal name, citation count (if available), and one sentence on why it matters to me. Always cite the external \nreference using a citation tag so I can add the ones I want. Do not add anything to my library. Just present the list.\n\nFormat your final response like this:\n\n[Short, high-level overview of what you found]\n\n1. **Smith (2019)**. Title of reference. *Name of Journal* (citations: X)\n[1-2 sentence on why this reference is relevant ending with a citation to the item]\n\n2. ... (repeat for up to 8 references)\n\n**Recap**: [End with a short recap of what you found and how it fits into my current work]',
        argumentHint: 'Name a topic or research question',
        targets: ['global'],
        category: 'research',
        sortOrder: 510,
    },

    {
        id: 'builtin-annotate',
        name: 'annotate',
        title: 'Annotate',
        text: 'Create highlight annotations based on my request.\n\nFirst determine the scope:\n- If I have a document open or attached, work within that document.\n- If my request names a topic across my library (for example, "all definitions of social capital"), search my library to find the relevant documents first. If the scope is ambiguous, or more than a handful of documents would be annotated, ask me to confirm the scope before creating anything.\n\nThen, for each relevant passage, create a highlight on the 1-3 sentences that actually match, with a short comment explaining why it matters. Be selective — a few precise highlights beat many loose ones.\n\nWhen done, summarize what you highlighted, grouped by document, citing the new annotations. If a document you searched had no matching passages, say so.',
        argumentHint: 'What to highlight, e.g. the open paper or "all definitions of social capital"',
        targets: ['global'],
        category: 'annotate',
        sortOrder: 515,
    },

    {
        id: 'builtin-create-note',
        name: 'create-note',
        title: 'Create a note',
        text: 'Write a Zotero note on the topic I describe, grounded in my library.\n\nSteps:\n1. If the topic is unclear, ask me before doing anything else.\n2. Search my library from several angles and read the most relevant passages — do not write from titles and metadata alone.\n3. Write a clear, well-structured note that synthesizes what my library says about the topic: a short title, a brief opening that states the takeaway, then sections in prose. Cite specific papers — and specific passages where possible — for every substantive claim.\n4. Where my library\'s evidence is thin, conflicting, or missing, say so explicitly in the note instead of papering over it. Do not assert anything you cannot support from my library.\n5. Save the result as a new Zotero note.',
        argumentHint: 'What should the note be about?',
        targets: ['global'],
        category: 'write',
        sortOrder: 520,
    },

    {
        id: 'builtin-tidy-up',
        name: 'tidy-up',
        title: 'Tidy up recent additions',
        text: 'Help me tidy up the recently added items attached to this message.\n\nSteps:\n1. Unless my message already says what to focus on, ask me which of these to do: add tags, file items into collections, fix missing metadata — or all three.\n2. Carry out the chosen tasks for each item:\n   - Tags: assign 2-5 subject tags, reusing my existing tags wherever they fit.\n   - Collections: add each item to the existing collection(s) where it clearly belongs; suggest a new collection only when nothing fits.\n   - Metadata: fill in missing fields such as DOI, abstract, publication details, and authors — verify against external sources rather than guessing.\n3. Finish with a compact summary of everything you changed, grouped by item, so I can review it.{{recent_items}}',
        argumentHint: 'Optional: what to focus on (e.g. just tagging, or fixing metadata)',
        targets: ['global'],
        category: 'organize',
        sortOrder: 530,
    },

    // Uncategorized: not shown on the homepage launcher, available from the
    // slash menu. A quick, tool-free answer for definitions and clarifications.
    {
        id: 'builtin-quick',
        name: 'quick',
        title: 'Quick answer',
        text: 'Answer my question directly from your own knowledge. Do not call any tools (no library search, no web search, no document reading, no metadata or file lookups). Keep the response concise and conversational rather than a full research answer.',
        argumentHint: 'Short, straightforward question (no detailed research)',
        targets: ['global'],
        sortOrder: 560,
    },

];

/**
 * Complete built-in base list: active actions plus deprecated tombstones from
 * `archivedActions.ts`. Use this — not `BUILTIN_ACTIONS` — wherever built-in
 * identity or override merging matters (merge loops, `isBuiltinAction`,
 * override diffing), so customizations of retired actions keep resolving
 * against their full default definition.
 */
export const ALL_BUILTIN_ACTIONS: Action[] = [...BUILTIN_ACTIONS, ...ARCHIVED_ACTIONS];
