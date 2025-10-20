# ![](/addon/content/icons/beaver_nomargin.png) Beaver

[![Create Beaver Account](https://img.shields.io/badge/Beaver_%F0%9F%A6%AB-Create_Account-red)](https://www.beaverapp.ai)

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Welcome to Beaver, a research agent with native Zotero integration. Beaver combines two parts:

1. **Advanced Research Agent**: An agentic system for scientific literature retrieval and synthesis from your library. It selects and composes strategies ranging from metadata queries to semantic and full‑text analysis, iteratively refining its approach. It reasons over your query, the paper you're reading, and your broader library to generate answers with sentence‑level citations.

2. **Native Zotero Integration**: Beaver runs inside Zotero, using your curated library and reading context. When you're viewing a PDF, Beaver knows which page you're on and relates it to the rest of your library without disrupting your workflow.

### Preview release

Beaver is in beta and available for free for a limited number of users during the beta. Sign up for the preview [here](https://www.beaverapp.ai). Key capabilities are still in progress, but current performance is strong and improving. We plan to offer a free version and a paid tier to cover ongoing development and operating costs.

We welcome feedback on GitHub. Access to the preview release may be limited based on server capacity.

## Key Features

1. **Research Agent**: Beaver uses multi-tool agentic search. It combines metadata, semantic, and full-document search (keyword + semantic), adapting its strategy to your task to locate specific passages across thousands of papers and synthesize findings.

2. **Seamless Zotero integration**: Beaver is a Zotero plugin. Ask about the paper you're reading, compare with other items in your library, or survey how concepts are treated across articles.

3. **Your Library as Knowledge Base**: Results come from your Zotero library (no generic web results) ensuring traceability to sources you trust.

4. **Precise, sentence-level Citations**: Every claim includes exact citations with direct links to specific sentences in your PDFs. Hover over a citation to see the text or click on it to reveal the exact passage in the document.

5. **Privacy**: We don't train models on your data without explicit opt-in. Local storage options for prompts and responses are under development to give you more control.

6. **Free Version**: During beta, the preview is free with unlimited metadata and related‑item search, plus free full‑document search for up to 75,000 pages (~2,500 articles). The beta also includes limited chat credits and the option to use your own API key for unlimited access to frontier models (OpenAI, Anthropic, Google). We will continue to offer a free version after the beta period and try to squeeze as much into it as we can reasonably support.

## Evaluations

We regularly run evaluations to track progress and guide development. One recent test used a modified version of the LitQA2 benchmark with 197 multiple-choice questions from Future House's [LAB‑Bench](https://github.com/Future-House/LAB-Bench). This benchmark emphasizes literature retrieval: answers are located in the main text of a single paper rather than abstracts or general knowledge.

![Figure: Performance comparison for Beaver Preview](/docs/litqa2-accuracy-preview.png)

On this task, Beaver’s retrieval from a pre-defined document set performed strongly. For context, we also compared the results to large models with general internet search tools. These are not directly comparable but the contrast gives a sense of how retrieval on a pre-defined library (such as your Zotero library) performs compared to general internet search.

This is only one dimension of evaluation. We also started to track other areas such as citation accuracy, handling of long documents, and integration into Zotero. More benchmarks and updates will follow as Beaver continues to develop.

## Getting started

1. Create an account and download Beaver [here](https://www.beaverapp.ai/join).
2. In Zotero, go to Tools → Add‑ons → Install Add‑on From File.
3. Select the downloaded `.xpi` file.
4. Open Beaver using the magic wand icon in the top‑right corner or press Cmd (macOS) / Ctrl (Windows) + L.

## How does Beaver work?

Beaver is a research agent with native Zotero integration that autonomously selects and combines search strategies to find relevant information. It syncs your library to our servers, prepares metadata and related‑item search, and processes your files for full‑text search. See our [privacy policy](https://www.beaverapp.ai/privacy-policy). We're also building features to keep more data local. Prefer a local‑only approach? Consider Zotero plugins like [A.R.I.A.](https://github.com/lifan0127/ai-research-assistant) or [Zotero MCP](https://github.com/54yyyu/zotero-mcp).

## How does library search work?

Beaver uses agentic search: the AI can choose among different search tools, filter based on metadata and iterate to explore your Zotero library. Currently, Beaver supports three search tools:

#### 1. Metadata Search

Find items by metadata (author, year, title). Ideal for locating specific references explicitly mentioned or inferred by context.

#### 2. Related Reference Search (Semantic)

Find conceptually related references even without keyword overlap (e.g., "crime" may surface work on incarceration, policing, or violence).

#### 3. Full-document Search (keyword and semantic)

Beaver uses hybrid search with reranking to search the content of your documents and retrieve relevant passages. Hybrid search combines keyword and semantic search based on embeddings to find relevant passages even without exact terms.

<!-- During the preview, the implementation of full-text search will change repeatedly as we continue to improve Beaver. -->

During the preview, full-document search is free for up to 75,000 pages (~2,500 articles).

Together these tools allow the agent explore your library to find relevant references, documents, and specific paragraphs/pages.

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

Beaver uses Gemini 2.5 Flash as the default model because it delivers great performance at a low price. GPT-5 Mini is a strong alternative at a similar cost, though our system prompt is not yet fully optimized for GPT-5, so occasional undesirable behavior may occur.

Frontier models such as GPT-5, Gemini 2.5 Pro, or Claude Sonnet 4 offer even higher performance. The difference is noticeable especially for complex questions and tasks.

Do keep in mind that Beaver often makes multiple model calls for a single query. When processing large amounts of context (e.g., several research papers), the cost of a single request can increase quickly. This is particularly true for Claude Sonnet 4 because it does not offer discounted rates for cached input tokens by default (we might add support later). A single request with Sonnet 4 can easily cost $0.5 or more. In contrast, OpenAI and Google reduce the cost of reusing the same input within 5 minutes by up to 90%, which is a significant advantage for agentic workflows.

### How do chat credits work?

Chat credits apply to both your messages and any related tool calls (e.g., metadata or full‑text searches). Each user message costs one credit. If the model invokes a tool, the server executes it and makes a second model call with the results, which costs another credit. A single question may involve multiple tool calls.

You can switch to your own API key at any time. When using your key, tool calls no longer consume chat credits. You only pay your provider directly per token usage.

### How do page limits work?

Page limits control how many pages are indexed for full-document search. If your library exceeds the limit, additional files aren't indexed for full‑text search. You can view files over the limit under "File Status" when starting a new thread.

Importantly, the page limit only affects full‑text search. Metadata and related‑reference search are unlimited. You can also manually add over‑limit documents to any chat. They're just excluded from full‑text search.

### What attachment types are supported?

Currently PDFs only with limits on per‑file pages and file size.

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

### Does Beaver provide other model providers?

Beaver includes an advanced setting to define custom models. These models are untested and not all features might be supported. Working with custom models can lead to unexpected errors or unexpected behavior. This might include certain functionality that simply doesn't work, errors without helpful messages or even wrong and misleading error messages, or model output that is undesirable (e.g. gpt-oss tends to include sentence ids such as '<s29‐s33>' in model responses). If you run into unexpected errors or problems, ALWAYS try the same with one of the fully supported models to see whether the issue is specific to your custom model.

You can add custom models under Zotero -> Preferences -> Advanced -> Config Editor → Search for "beaver.customChatModels". The field must be a valid JSON array where each object contains the following fields:

- `provider`: Model provider. Currently only is supported provider is 'openrouter'
- `api_key`: API kep for the provider
- `name`: The model name as it appears in the model selector
- `snapshot`: The model snapshot such as 'openai/gpt-oss-120b' or 'z-ai/glm-4.6'

To ensure the JSON is correctly formatted, you can use a json validator such as this [one](https://jsonlint.com/) (do not pass your actual API key to the validator and make sure you use the correct one for "beaver.customChatModels").

Important: After changing the "beaver.customChatModels" config, always open and close Beaver settings. This is required to update the list of models in the model selector.

Example setting to add GLM 4.6 and gpt-oss-120b:

```json
[
  {
    "provider": "openrouter",
    "api_key": "XXX",
    "name": "GLM 4.6",
    "snapshot": "z-ai/glm-4.6"
  },
  {
    "provider": "openrouter",
    "api_key": "XXX",
    "name": "GLM 4.6",
    "snapshot": "openai/gpt-oss-120b"
  }
]
```
