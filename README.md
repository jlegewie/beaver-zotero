# ![](/addon/content/icons/beaver_nomargin.png) Beaver

[![Create Beaver Account](https://img.shields.io/badge/Beaver_%F0%9F%A6%AB-Create_Account-red)](https://www.beaverapp.ai)
[![Beaver Documentation](https://img.shields.io/badge/Documentation-blue)](https://www.beaverapp.ai/docs)

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![zotero target version](https://img.shields.io/badge/Zotero-8-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Welcome to Beaver, a research agent with native Zotero integration. Beaver combines two parts:

1. **Advanced Research Agent**: An agentic system for scientific literature retrieval and synthesis from your library. It selects and composes strategies ranging from metadata queries to semantic and full‑text analysis, iteratively refining its approach. It reasons over your query, the paper you're reading, your broader library and searches the web to generate answers with sentence‑level citations.

2. **Native Zotero Integration**: Beaver runs inside Zotero, using your curated library and reading context. When you're viewing a PDF, Beaver knows which page you're on and relates it to the rest of your library without disrupting your workflow.

### Preview release

Beaver is in beta and available for free for a limited number of users during the beta. Sign up for the preview [here](https://www.beaverapp.ai). Key capabilities are still in progress, but current performance is strong and improving. We plan to offer a free version and a paid tier to cover ongoing development and operating costs.

We welcome feedback on GitHub. Access to the preview release may be limited based on server capacity.

## Key Features

1. **Chat with your Entire Library**: Ask questions about your research and get answers drawn from your entire library. Beaver searches across metadata, topics, and the full content of your PDFs to give grounded answers. [Learn more]https://www.beaverapp.ai/docs/searching)

2. **Discover New Research**: Search over 250 million scholarly works outside your Zotero library. Understand citation patterns and find papers to expand your collection. [Learn more](https://www.beaverapp.ai/docs/web-search)

3. **Seamless Zotero integration**: Lives directly in Zotero as a side panel. Ask questions about the paper you're reading, and Beaver knows exactly which page you're on.

4. **Your Library as Knowledge Base**: Beaver prioritizes your curated Zotero library and sources you trust, not generic web results.

5. **Precise, Sentence-Level Citations**: Answers include direct sentence-level citations that link back to your source PDFs, ensuring transparency and verifiability.

6. **Annotate Your PDFs**: Beaver can highlight and add notes to your PDFs when you ask. [Learn more](https://www.beaverapp.ai/docs/annotations)

7. **Privacy**: We don't train models on your data without explicit opt-in. Local storage options for prompts and responses are under development to give you more control.

8. **Free Version**: During beta, the preview is free with unlimited metadata and related‑item search, plus free full‑document search for up to 125,000 pages (~4,000 articles). The beta also includes limited chat credits and the option to use your own API key for unlimited access to frontier models (OpenAI, Anthropic, Google). We will continue to offer a free version after the beta period and try to squeeze as much into it as we can reasonably support.

Under the hood, Beaver is an AI agent with agentic search and other tools to help you in the research process. It combines metadata, semantic, and full-document search (keyword + semantic), adapting its strategy to your task to locate specific passages across thousands of papers and synthesize findings.

## Evaluations

We regularly run evaluations to track progress and guide development. One recent test used a modified version of the LitQA2 benchmark with 197 multiple-choice questions from Future House's [LAB‑Bench](https://github.com/Future-House/LAB-Bench). This benchmark emphasizes literature retrieval: answers are located in the main text of a single paper rather than abstracts or general knowledge.

![Figure: Performance comparison for Beaver Preview](/docs/litqa2-accuracy-preview.png)

On this task, Beaver’s retrieval from a pre-defined document set performed strongly. For context, we also compared the results to large models with general internet search tools. These are _not directly comparable_ but the contrast gives a sense of how retrieval on a pre-defined library (such as your Zotero library) performs compared to general internet search.

This is only one dimension of evaluation (and not the hardest). We also track other areas such as citation accuracy, handling of long documents, and integration into Zotero. More benchmarks and updates will follow as Beaver continues to develop.

## Getting started

1. Create an account and download Beaver [here](https://www.beaverapp.ai/join).
2. In Zotero, go to Tools → Add‑ons → Install Add‑on From File.
3. Select the downloaded `.xpi` file.
4. Open Beaver using the magic wand icon in the top‑right corner or press Cmd (macOS) / Ctrl (Windows) + L.

More details are available in the [documentation](https://www.beaverapp.ai/docs/getting-started).

## How does Beaver work?

Beaver is a research agent with native Zotero integration that autonomously selects and combines search strategies to find relevant information. It syncs your library to our servers, prepares metadata and related item search, and processes your files for full‑text search. See our [privacy policy](https://www.beaverapp.ai/privacy-policy). We're also building features to keep more data local. Prefer a local‑only approach? Consider Zotero plugins like [A.R.I.A.](https://github.com/lifan0127/ai-research-assistant) or [Zotero MCP](https://github.com/54yyyu/zotero-mcp).

## How does library and web search work?

You can find a detailed discussion of how Beaver searches your library [here](https://www.beaverapp.ai/docs/searching). Discover new research with web search is discussed [here](https://www.beaverapp.ai/docs/web-search).

Beaver always prioritzies your library and is only encouraged to search for external references when your library contains limited information or when you ask for it.

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

Beaver support models from OpenAI, Google and Anthropic. Advanced users can also use models from Openrouter (see details [here](https://www.beaverapp.ai/docs/custom-models)). We recommend frontier models such as GPT-5, Gemini 2.5 Pro, or Claude Sonnet 4.5 for optimal performance. Haiku 4.5 is a great alternative at lower costs! Gemini 2.5 Flash also works well at a very low price-point for simpler requets that do not require multiple step reasoning or searches.

Do keep in mind that Beaver often makes multiple model calls for a single query. When processing large amounts of context (e.g., several research papers), the cost of a single request can increase.

### How do page and chat credits work?

See a detailed discussion of page and chat credits [here](https://www.beaverapp.ai/docs/credits).

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

### Is Beaver open source?

The Zotero plugin is open source under the [AGPL‑3.0 License](LICENSE). The backend, server, and file‑processing code are not open source.

### Does Beaver support other model providers?

Beaver includes an advanced setting to define custom models. These models are untested and not all features are be supported. You can learn more [here](https://www.beaverapp.ai/docs/custom-models)

## System Requirements

- Zotero 7.0 or later
- Internet connection for cloud features
- Modern web browser for account management
