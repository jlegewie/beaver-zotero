# ![](/addon/content/icons/beaver_nomargin.png) Beaver

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

[![Create Beaver Account](https://img.shields.io/badge/Beaver_%F0%9F%A6%AB-Create_Account-red)](https://www.beaverapp.ai)

Welcome to Beaver! Beaver is an **AI plugin for Zotero** designed by academic researchers to help with the research process. What, another AI plugin for Zotero? Yes, indeed! But we think the feature set makes it compelling. There are other excellent options available, and you should explore them all. Here are some things that make Beaver special.

**Preview**: Beaver is currently in beta!

## Key Features

1. **Agentic Search**. Beaver intelligently searches your library using metadata, semantic similarity, and full-text search to find exactly what you need.

2. **Seamless Integration into Zotero Library and PDF Reader**. Lives directly in Zotero as a side panel. Ask questions about the paper you're reading, and Beaver knows exactly which page you're on.

3. **Precise Citations**. Answers include direct citations with page-level links back to your source PDFs, ensuring transparency and verifiability.

4. **Your Library, Your Control**. Works exclusively with your curated Zotero library. No generic web results, only insights from sources you trust.

5. **Built with Privacy in Mind**: Your data stays yours. We don't train models on your data without explicit opt-in, and we're building local storage options.

6. **Accessible by Design**: Created by academics who believe powerful research tools shouldn't be locked behind expensive paywalls.

## Getting started

1. Create an account and download Beaver [here](https://www.beaverapp.ai/join)
2. In Zotero, go to Tools → Add-ons → Install Add-on From File
3. Select the downloaded `.xpi` file
4. Open Beaver using the magic wand icon in the top right corner or by pressing cmd (Mac) or Ctrl (Windows) + L

## How does Beaver work?

Beaver syncs your entire library with our servers, prepares your library for metadata and related reference search, and processes your files for full-text search all in the cloud. We have a strict [privacy policy](https://your-website.com/privacy) in place and are working on additional features that will allow you to keep key data locally. If you prefer a local solution, we suggest one of the many Zotero plugins such as [A.R.I.A.](https://github.com/lifan0127/ai-research-assistant) or [Zotero MCP](https://github.com/54yyyu/zotero-mcp).

## How does library search work?

Beaver uses **agentic search**, meaning the AI agent can choose between different search tools and use them iteratively to explore your Zotero library. Currently, Beaver has access to three types of search:

#### 1. Metadata Search

This search finds Zotero items using metadata such as author, year, or title. It's best for locating specific references either because you mention an author directly, or because the model identifies a reference as important based on context. Metadata search will remain free and unlimited.

#### 2. Related Reference Search (Semantic Search)

This search finds references that are conceptually related to a topic, even if they don't use the same keywords. For example, a search for crime may surface articles about incarceration, policing, or violence even if the word crime isn't mentioned. Related reference search will remain free and unlimited.

#### 3. Full-text Search (keyword and semantic)

This is the most powerful search option, as it works on the full content of your documents. Beaver uses two different methods:

- **Keyword search**: Finds matching terms in the full text of your library (up to your plan's page limit). As part of an agentic AI system, it performs surprisingly well. Our systematic evaluations show strong performance on key benchmarks. During the beta, it’s free for up to 75,000 pages (roughly 2,500 articles).

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
