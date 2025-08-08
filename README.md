# ![](/addon/content/icons/beaver_nomargin.png) Beaver

[![Create Beaver Account](https://img.shields.io/badge/Beaver_%F0%9F%A6%AB-Create_Account-red)](https://www.beaverapp.ai)

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Welcome to Beaver! Beaver is a research agent with native Zotero integration to make it accessible and easy to use. Beaver combines two components:

1. **An Advanced Research Agent**: At its core, Beaver is an AI agent engineered to achieve expert-level performance in scientific literature retrieval and synthesis. Using agentic search, Beaver autonomously selects and combines different search strategies from metadata queries to semantic similarity matching to full-text analysis. It iteratively refining its approach until it finds precisely what you need. The agent reasons about your query, considers the article you are reading, extracts key information, and formulates comprehensive answers with page-level citations back to your source materials.

2. **Native Zotero Integration**: Unlike standalone AI tools, Beaver lives directly within your research workflow as a Zotero plugin. This tight integration means the agent has immediate access to your curated library, understands the context of what you're reading, and can provide insights without disrupting your work. When you're reading a PDF, Beaver knows exactly which page you're on and can relate that content to everything else in your library.

### Preview release

Beaver is currently in beta and available for free. You can sign up for the preview release [here](https://www.beaverapp.ai). Important capabilities are still missing. However, the preview release already performs very well on key benchmarks and will continue to improve. In the future, we will offer both a free version and a paid version with advanced features priced to cover the cost of running and developing Beaver.

During this free preview release, we ask for feedback here on Github or via our Slack.

We might restrict access to the preview release depending on server capacities.

## Key Features

1. **Autonomous Research Agent**. Beaver employs multi-tool agentic search that goes beyond simple queries. The agent strategically combines metadata search, semantic similarity analysis, and full-text retrieval. It adapts its strategy based on your question. It can identify relevant passages across thousands of papers, and synthesize findings into coherent answers.

2. **Context-Aware Intelligence**. Beaver is seamlessly integrated into Zotero's interface. It understands your reading context. Ask questions about the paper you're currently reading, request comparisons with other work in your library, or explore how concepts are treated across different articles without leaving your PDF reader.

3. **Your Library as Knowledge Base**. Works exclusively with your curated Zotero collection, ensuring that all insights come from sources you trust. No generic web results or unverified content, just deep analysis of the papers you've chosen to include in your research.

4. **Precise Citations**. Every claim is backed by exact citations with direct links to the source page in your PDFs, ensuring transparency and verifiability.

5. **Built with Privacy in Mind**: Your research stays yours. We don't train models on your data without explicit opt-in consent. Local storage options for prompts and responses are in development, giving you complete control over where your prompts reside.

6. **Free version**: The preview release is free during the beta period with unlimited metadata and related item search, plus free full-text search for up to 75,000 pages (approximately 2,500 articles). It includes limited chat credits and options for using your own API key for unlimited use with frontier models from OpenAI, Anthropic and Google. We will continue to offer a free version after the beta period and try to squeeze as much into it as we can reasonably support.

## Getting started

1. Create an account and download Beaver [here](https://www.beaverapp.ai/join)
2. In Zotero, go to Tools → Add-ons → Install Add-on From File
3. Select the downloaded `.xpi` file
4. Open Beaver using the magic wand icon in the top right corner or by pressing cmd (Mac) or Ctrl (Windows) + L

## How does Beaver work?

Beaver is a research agent with native Zotero integration that autonomously selects and combines different search strategies to find relevant information. It syncs your entire library with our servers, prepares your library for metadata and related reference search, and processes your files for full-text search all in the cloud. We have a strict [privacy policy](https://your-website.com/privacy) in place and are working on additional features that will allow you to keep key data locally. If you prefer a local solution, we suggest one of the many Zotero plugins such as [A.R.I.A.](https://github.com/lifan0127/ai-research-assistant) or [Zotero MCP](https://github.com/54yyyu/zotero-mcp).

## How does library search work?

Beaver uses **agentic search**, meaning the AI agent can choose between different search tools and use them iteratively to explore your Zotero library. Currently, Beaver has access to three types of search:

#### 1. Metadata Search

This search finds Zotero items using metadata such as author, year, or title. It's best for locating specific references either because you mention an author directly, or because the model identifies a reference as important based on context.

#### 2. Related Reference Search (Semantic Search)

This search finds references that are conceptually related to a topic, even if they don't use the same keywords. For example, a search for crime may surface articles about incarceration, policing, or violence even if the word crime isn't mentioned.

#### 3. Full-text Search (keyword and semantic)

This is the most powerful search option, as it works on the full content of your documents. Beaver uses two different methods:

- **Keyword search**: Finds matching terms in the full text of your library (up to the page limit). As part of an agentic AI system, it performs surprisingly well. Our systematic evaluations show strong performance on key benchmarks. During the preview release, full-text keyword search is free for up to 75,000 pages (roughly 2,500 articles).

- **Hybrid search**: Combines keyword and semantic search to retrieve relevant passages even when exact keywords aren't present. This is the current state-of-the-art in search for RAG (retrieval-augmented generation) applications.

Together, these tools allow the research agent to explore your library and find relevant references, documents, or specific paragraphs and pages.

## Responsible Use of Generative AI in Academic Research

The use of generative AI in academic research is a hotly debated topic (see one discussion [here](https://statmodeling.stat.columbia.edu/2025/07/18/i-am-no-longer-chairing-defenses-or-joining-committees-where-students-use-generative-ai-for-their-writing/#comments)). Everyone using these tools should engage with these questions and understand that there are very different views. As the developers of Beaver, we want to highlight some important things when using generative AI tools such as Beaver for academic research and writing.

**First and foremost**, students should talk with their advisor, committee, mentor, department, or other relevant people about how and when you are allowed to use generative AI. Rules will differ and it is important to be upfront to avoid any misunderstanding later on. Many universities, departments, journals, publishers, etc. have rules and guidelines. Make sure you are familiar with them.

**Second**, we are excited about the potential that generative AI brings to the research process. We believe that using generative AI responsibly can empower students and researchers to do better work. This includes using generative AI as a tutor that helps you understand complicated concepts, as a research assistant that searches for and compiles relevant references, and as a brainstorming partner that can rely on your entire Zotero library. Beaver and generative AI provide 24/7 access to all this and more even when you don't have access to tutors, patient instructors, or the funds to hire a research assistant.

## Frequently Asked Questions

### What is the difference between Beaver and any other generative AI tool such as ChatGPT?

Beaver is designed specifically for academic research. It relies on and incorporates references from _your_ Zotero library so you can curate the information used by Beaver. It also directly integrates into your reference manager for easy access directly where you work and read PDFs.

Here are some examples of the types of questions you might ask Beaver. In each case, the difference compared to ChatGPT, Claude etc is that Beaver will search _your_ library for relevant materials, correctly cite these materials and link back to the source document.

- "I don't understand the difference between 'legal cynicism' and 'legal estrangement'. Can you give me a clear definitions and discuss how the two terms are used in empirical research?"
- "What are the key findings in this article and how do they relate to other research? Identify the key findings and then search for other research that either supports or contradicts the key findings."
- "Has any research looked at the interaction between socioeconomic status and educational outcomes?"
- "I am using cross-validation for my current machine learning project. How do other research articles typically describe or report the details of their cross-validation procedures?"
- _(Zotero PDF reader)_ "Why do they control for income in their model? Does other research on the same topic do that as well?"
- _(Zotero PDF reader)_ "The measure of wealth doesn't make sense to me. How do other studies measure wealth?"

### Do you store and use my data?

Beaver syncs your data with our servers, uploads your attachment files, and processes your attachments in the cloud to provide all the functionality. We have a detailed [privacy policy](https://www.beaverapp.ai/privacy-policy). In short, your data will not be sold or used for model training etc unless you opt in to help improve Beaver (the default is opt out). In addition, we are working on features that will allow you to store chats locally (Zotero data will still be synced).

If you prefer local solutions, take a look at other Zotero plugins such as [A.R.I.A.](https://github.com/lifan0127/ai-research-assistant) or [Zotero MCP](https://github.com/54yyyu/zotero-mcp).

### How do chat credits work?

Chat credits apply to both your chat messages and any related tool calls (e.g. metadata searches, full-text searches). Each time you send a message to the model, you spend one chat credit.

If the model requests a tool call, our servers execute the tool (e.g. searches for relevant Zotero items) and feed the results back to the model in a second request. This second request costs one more chat credit. A single question can generate multiple tool calls and each tool call costs an additional chat credit.

If you prefer, you can switch to using your own API key at any time. In that case, tool calls no longer consume chat credits. You'll pay your API provider directly according to their token-usage rates.

### How do page limits work?

The page limits determine how many pages will be indexed for full-text search. If the size of your library exceeds the page limit, additional files will not be indexed for search. You can see any files that exceed the limit under "File Status" when starting a new thread.

Importantly, the page limit _only_ impacts full-text search! Metadata and related reference search is unlimited. You can also manually add documents that exceed your page balance to any chat. The document is just excluded from full-text search.

### What types of attachments are supported?

Currently, Beaver only supports PDF files. Additional file types will be supported later. Each plan also imposes limits on the number of pages and file size of each attachment.

### How can I improve the results?

Beaver explores your Zotero library using different search tools. When your library is disorganized, Beaver has a harder time finding the correct references and attachments.

Here are two concrete tips:

1. **Maintain a clean Zotero library**: Beaver searches your Zotero library, so maintaining a clean library helps a lot! For example, using clear filenames helps Beaver identify the right items and attachments. Using "main_article.pdf", "appendix.pdf" and "book_review.pdf" as filenames helps Beaver distinguish the different types of documents. In most cases this won't make a difference, but it is one example of countless ways in which Beaver relies on the data in your library.

2. **Use custom prompts**: Add details to the custom prompt under preferences. This text will be added to every conversation and helps Beaver understand your specific research context and preferences.

3. **Help improve Beaver**: Considering enabling data sharing in your account settings to help us improve Beaver. We only use anonymized data.

## System Requirements

- Zotero 7.0 or later
- Internet connection for cloud features
- Modern web browser for account management

## Is Beaver open source?

The Zotero plugin is open source and licensed under the [AGPL-3.0 License](LICENSE). The backend, server, and file processing code is not open source.
