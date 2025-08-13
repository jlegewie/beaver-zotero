# ![](/addon/content/icons/beaver_nomargin.png) Beaver

[![Create Beaver Account](https://img.shields.io/badge/Beaver_%F0%9F%A6%AB-Create_Account-red)](https://www.beaverapp.ai)

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Welcome to Beaver, a research agent with native Zotero integration. Beaver combines two parts:

1. **Advanced Research Agent**: An agentic system for scientific literature retrieval and synthesis. It selects and composes strategies ranging from metadata queries to semantic and full‑text analysis, iteratively refining its approach. It reasons over your query, the paper you're reading, and your broader library to generate answers with page‑level citations.

2. **Native Zotero Integration**: Beaver runs inside Zotero, using your curated library and reading context. When you're viewing a PDF, Beaver knows which page you're on and relates it to the rest of your library without disrupting your workflow.

### Preview release

Beaver is in beta and available for free. Sign up for the preview [here](https://www.beaverapp.ai). Key capabilities are still in progress, but current performance is strong and improving. We plan to offer a free version and a paid tier to cover ongoing development and operating costs.

We welcome feedback on GitHub and in Slack. Access to the preview release may be limited based on server capacity.

## Key Features

1. **Autonomous Research Agent**: Beaver uses multi‑tool agentic search that goes beyond simple queries. The agent combines metadata, semantic, and full‑text retrieval, adapting its strategy to your task to find specific passages across thousands of papers and synthesize findings.

2. **Context‑Aware Intelligence**: Tight Zotero integration. Ask about the paper you're reading, compare with other items in your library, or survey how concepts are treated across articles; all without leaving the PDF reader.

3. **Your Library as Knowledge Base**: Results come from your Zotero library (no generic web results) ensuring traceability to sources you trust.

4. **Precise Citations**: Every claim includes exact citations with direct links to the source pages in your PDFs.

5. **Privacy**: We don't train models on your data without explicit opt-in. Local storage options for prompts and responses are under development to give you more control.

6. **Free Version**: During beta, the preview is free with unlimited metadata and related‑item search, plus free full‑text search for up to 75,000 pages (~2,500 articles). Includes limited chat credits and the option to use your own API key for unlimited access to frontier models (OpenAI, Anthropic, Google). We will continue to offer a free version after the beta period and try to squeeze as much into it as we can reasonably support.

## Evaluations

We continuously evaluate Beaver to guide development. Early results on a modified version of the LitQA2 benchmark using 197 multiple‑choice questions from Future House's [LAB‑Bench](https://github.com/Future-House/LAB-Bench) show strong performance. LitQA2 emphasizes genuine literature retrieval: answers are in main texts (not abstracts) and ideally in a single paper, pushing systems to find and read the correct source rather than rely on memorization.

Beaver's agentic search outperforms baselines, including tool‑augmented frontier models, on this task. Performance varies by model, from 92.4% (GPT‑5) to 77.9% (Gemini 2.5 Flash). From a cost‑effectiveness standpoint, Beaver with GPT‑5 Mini achieves 83.5% accuracy at approximately $0.0102 per task (about 1.25× the cost of Gemini 2.5 Flash).

<!-- As an additional comparison, [Lála et al. (2023)](https://arxiv.org/abs/2312.07559) report accuracy for Perplexity of 18%, Perplexity (Co‑pilot) of 58%, Elicit of 24%, Scite of 24%, AutoGPT of 41.4%, PaperQA of 69.5%, and human performance of 66.8%. However, direct comparisons to Beaver are problematic. -->

![Figure: Performance comparison for Beaver Preview](/docs/litqa2-accuracy-preview.png)

We use these and other evaluations to refine search strategies, improve citation accuracy, and strengthen cross‑domain performance. We'll share additional benchmarks and updates as Beaver evolves.

## Getting started

1. Create an account and download Beaver [here](https://www.beaverapp.ai/join).
2. In Zotero, go to Tools → Add‑ons → Install Add‑on From File.
3. Select the downloaded `.xpi` file.
4. Open Beaver using the magic wand icon in the top‑right corner or press Cmd (macOS) / Ctrl (Windows) + L.

## How does Beaver work?

Beaver is a research agent with native Zotero integration that autonomously selects and combines search strategies to find relevant information. It syncs your library to our servers, prepares metadata and related‑item search, and processes your files for full‑text search. See our [privacy policy](https://www.beaverapp.ai/privacy-policy). We're also building features to keep more data local. Prefer a local‑only approach? Consider Zotero plugins like [A.R.I.A.](https://github.com/lifan0127/ai-research-assistant) or [Zotero MCP](https://github.com/54yyyu/zotero-mcp).

## How does library search work?

Beaver uses agentic search: the AI can choose among different search tools and iterate to explore your Zotero library. Currently, Beaver supports three search tools:

#### 1. Metadata Search

Find items by metadata (author, year, title). Ideal for locating specific references explicitly mentioned or inferred by context.

#### 2. Related Reference Search (Semantic)

Find conceptually related references even without keyword overlap (e.g., "crime" may surface work on incarceration, policing, or violence).

#### 3. Full‑text Search (keyword and semantic)

Beaver uses two complementary methods for full-text search:

- **Keyword search**: Finds term matches across your indexed full text (up to your page limit). Works surprisingly well within the agentic system and performs strongly in evaluations. During the preview, full‑text keyword search is free for up to 75,000 pages (~2,500 articles).

- **Hybrid search**: Relies on more advanced document processing to combine keyword and semantic search to retrieve relevant passages even without exact terms.

Together these tools let the agent explore your library to find relevant references, documents, and specific paragraphs/pages.

## Responsible Use of Generative AI in Academic Research

The role of generative AI in research is actively debated (see one discussion [here](https://statmodeling.stat.columbia.edu/2025/07/18/i-am-no-longer-chairing-defenses-or-joining-committees-where-students-use-generative-ai-for-their-writing/#comments)). Engage with the issues and understand that views differ.

- **First**, consult your advisor, committee, department, or other stakeholders on how and when you may use generative AI. Rules vary. Be transparent to avoid misunderstandings.
- **Second**, we see substantial potential when used responsibly as a tutor, a research assistant that compiles references, and a brainstorming partner grounded in your Zotero library and available 24/7 even without access to tutors or funded RAs.

## Frequently Asked Questions

### What's the difference between Beaver and general‑purpose tools like ChatGPT?

Beaver is built for academic research and works directly with your Zotero library, ensuring you can curate sources. It integrates into Zotero for easy access where you read PDFs and writes answers with correct citations and links back to the source document. On evaluations, it significantly outperforms general purpose chat bots for scientific literature retrieval and reasoning.

Examples of useful prompts:

- "What's the difference between 'legal cynicism' and 'legal estrangement'? Provide clear definitions and discuss empirical usage."
- "What are the key findings of this article, and how do they relate to other work? Identify the findings and search for supporting or contradicting research."
- "Has research examined interactions between socioeconomic status and educational outcomes?"
- (In the Zotero PDF reader) "Why do they control for income here? Do other studies in this area do the same?"
- (In the Zotero PDF reader) "This measure of wealth is unclear. How do other studies measure wealth?"

### Do you store and use my data?

Beaver syncs your data, uploads attachments, and processes files in the cloud to provide functionality. See our detailed [privacy policy](https://www.beaverapp.ai/privacy-policy). We do not sell your data or train models on it unless you explicitly opt in. We're also working on features to store chats locally (Zotero data will still sync).

Prefer local‑only solutions? Consider [A.R.I.A.](https://github.com/lifan0127/ai-research-assistant) or [Zotero MCP](https://github.com/54yyyu/zotero-mcp).

### Which models do you recommand?

Beaver uses Gemini 2.5 Flash as the default model because it delivers excellent performance at a low price. GPT-5 Mini is a strong alternative at a similar cost, though our system prompt is not yet fully tuned for GPT-5, so occasional undesirable behavior may occur.

Frontier models such as GPT-5, Gemini 2.5 Pro, or Claude Sonnet 4 offer even higher performance, especially for complex questions and tasks. Do keep in mind that Beaver often makes multiple model calls for a single query. When processing large amounts of context (e.g., several research papers), the cost of a single request can increase quickly. GPT-5, in particular, tends to pull in extensive context, which increases benchmark performance but also cost. For example,

Claude Sonnet 4 is an excellent choice, especially for agentic applications like Beaver. That said, Anthropic's pricing model is more expensive in Beaver because it does not offer discounted rates for cached inputs (at least not by default). In contrast, OpenAI and Google reduce the cost of reusing the same input within 5 minutes by up to 90%, which is a significant advantage for agentic workflows.

### How do chat credits work?

Chat credits apply to both your messages and any related tool calls (e.g., metadata or full‑text searches). Each user message costs one credit. If the model invokes a tool, the server executes it and makes a second model call with the results, which costs another credit. A single question may involve multiple tool calls.

You can switch to your own API key at any time. When using your key, tool calls no longer consume chat credits. You only pay your provider directly per token usage.

### How do page limits work?

Page limits control how many pages are indexed for full‑text search. If your library exceeds the limit, additional files aren't indexed for full‑text search. You can view files over the limit under "File Status" when starting a new thread.

Importantly, the page limit only affects full‑text search. Metadata and related‑reference search are unlimited. You can manually add over‑limit documents to any chat; they're just excluded from full‑text search.

### What attachment types are supported?

Currently PDFs only. Each plan also sets limits on pages and per‑file size.

### How can I improve the results?

Beaver explores your library using different tools. A clean library helps it find the most relevant information.

1. **Keep Zotero organized**: Clear filenames (e.g., `main_article.pdf`, `appendix.pdf`, `book_review.pdf`) help Beaver distinguish document types and improve retrieval accuracy.

2. **Use custom prompts**: Add details in Preferences → Custom Prompt. This text is included in every conversation and helps tailor results to your context.

3. **Help improve Beaver**: Consider enabling anonymized data sharing in account settings.

### Verification for OpenAI API keys

If you are trying to use your own OpenAI API key, you might run into to the verification error. Unfortunatly, OpenAI requires verification including ID check before using API keys for streaming model responses (which is pretty essential for a good user experience in chat applications). You can resolve this issue by going [here](https://platform.openai.com/settings/organization/general) and clicking on Verify Organization. If you just verified, it can take up to 15 minutes for access to propagate.

If this requirement motivates you to try a different provider, I suggest adding an API key for Gemini ([link](https://aistudio.google.com/app/apikey)).

## System Requirements

- Zotero 7.0 or later
- Internet connection for cloud features
- Modern web browser for account management

## Is Beaver open source?

The Zotero plugin is open source under the [AGPL‑3.0 License](LICENSE). The backend, server, and file‑processing code are not open source.
