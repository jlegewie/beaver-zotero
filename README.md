# ![](/addon/content/icons/beaver_nomargin.png) Beaver

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Welcome to Beaver! Beaver is an **AI plugin for Zotero** designed by academic researchers to help with the research process. What, another AI plugin for Zotero? Yes, indeed! But we think the feature set makes it compelling. There are other excellent options available, and you should explore them all. Here are some things that make Beaver special.

**Beta**: Beaver is currently in beta!

## Key Features

1. **Seamless integration into Zotero Library and PDF Reader**. As a side panel, Beaver is right there in Zotero and always knows what you are doing. Reading an article in Zotero? Beaver knows which one it is and can see the page you are on. This seamless integration makes it easy to ask questions about your references and allows for natural queries such as "Can you explain this super-duper complicated equation to me?".

2. **Metadata and related reference search**. Beaver can search your entire library by metadata (author, year, title) or for references related to a specific topic (semantic search). All 100% free, without limits.

3. **Full-text search**. Beaver processes all of your attachments (up to a page limit) for its most powerful search tool: full-text search. Depending on your plan, it uses either keyword search or hybrid search, which combines keyword matching with semantic search based on embeddings.

4. **Research agent**. Beaver is _agentic_ and can iteratively search your library using different search strategies to find relevant information.

5. **Citations**. Beaver cites references from your library with direct links to the relevant page making it easy to explore the underlying source materials.

6. **Feature-rich free version**: We have a feature-packed free version with unlimited metadata and related item search, and unlimited use with your own API keys.

7. **Soon: Advanced paid version**: To enable all features such as advanced file processing, powerful hybrid search for large libraries and more, we plan to introduce paid versions that cover the cost of operation.

## Getting started

1. Create an account and download Beaver [here](https://www.beaverapp.ai/join)
2. In Zotero, go to Tools → Add-ons → Install Add-on From File
3. Select the downloaded `.xpi` file
4. Open Beaver using the magic wand icon in the top right corner or by pressing cmd (Mac) or Ctrl (Windows) + L

## How does Beaver work?

Beaver syncs your entire library with our servers, prepares your library for metadata and related reference search, and processes your files for full-text search all in the cloud. We have a strict [privacy policy](https://your-website.com/privacy) in place and are working on additional features that will allow you to keep key data locally. If you prefer a local solution, we suggest one of the many Zotero plugins such as [A.R.I.A.](https://github.com/lifan0127/ai-research-assistant) or [Zotero MCP](https://github.com/54yyyu/zotero-mcp).

## How does library search work?

Library search is important to understand how Beaver works. Beaver uses **agentic search**, which means that the large language model has access to different search tools and can decide when to use which type of search to iteratively explore your library. Currently, Beaver has access to three search tools:

#### 1. Metadata Search

Metadata search finds Zotero items by metadata such as author, year, or title. This search allows the model to find specific references either because you ask for articles by a specific author or because it determined that a specific reference is important based on other papers.

- **Free plan**: Unlimited across your entire Zotero library
- **Paid plans**: Unlimited across your entire Zotero library

#### 2. Related Reference Search

Related reference search finds Zotero items based on semantic similarity. It allows the model to find all references related to a specific topic. For example, searching for "crime" will find articles that are related to the topic regardless of whether they use the word "crime" in the title or abstract.

- **Free plan**: Unlimited across your entire Zotero library
- **Paid plans**: Unlimited across your entire Zotero library

#### 3. Full-text Search

Full-text search is the most powerful search tool that requires document processing. Beaver uses two types of full-text search:

- **Keyword search**: Keyword search uses keyword matching to search the full-text of your library up to the plan limit (free during the beta period for 75,000 pages or about 2,500 articles). Keyword search is similar to Zotero's built-in full-text search. Beaver improves on that with additional processing and by splitting documents into pages, which allows the model to better cite specific parts of articles. Keyword search is particularly powerful with an AI system that is optimized to formulate good keyword search terms. I mean, who types this in the search bar: `("education" OR "school achievement" OR "academic performance") AND ("socioeconomic status" OR "poverty" OR "income inequality" OR "class background")`. We are currently evaluating whether we can offer keyword search as part of the free plan but it might be associated with a small fee because of the cost associated with processing large libraries and maintaining search indices.

- **Hybrid search**: Hybrid search combines keyword search with semantic search. Hybrid search can retrieve parts of documents based either on keyword matching or on semantic similarity. Hybrid search is considered the state-of-the-art search approach in RAG applications.

Together, these search tools allow the research agent to iteratively explore your library and find relevant references, documents or specific paragraphs and pages within them.

## Responsible Use of Generative AI in Academic Research

The use of generative AI in academic research is a hotly debated topic (see one discussion [here](https://statmodeling.stat.columbia.edu/2025/07/18/i-am-no-longer-chairing-defenses-or-joining-committees-where-students-use-generative-ai-for-their-writing/#comments)). Everyone using these tools should engage with these questions and understand that there are very different views. As the developers of Beaver, we want to highlight some things that we think are important for using generative AI tools such as Beaver for academic research and writing.

**First and foremost**, students should talk with their advisor, committee, mentor, department, or other relevant people about how and when you are allowed to use generative AI. Rules will differ and it is important to be upfront to avoid any misunderstanding later on. Many universities, departments, journals, publishers, etc. have rules and guidelines. Make sure you are familiar with them.

**Second**, we are excited about the potential that generative AI brings to the research process. We believe that using generative AI responsibly can empower students and researchers to do better work. This includes using generative AI as a tutor that helps you understand complicated concepts, as a research assistant that searches for and compiles relevant references, and as a brainstorming partner that can rely on your entire Zotero library. Beaver and generative AI provide 24/7 access to all this and more even when you don't have access to tutors, patient instructors, or the funds to hire a research assistant.

## Frequently Asked Questions

### What is the difference between Beaver and any other generative AI tool such as ChatGPT?

Beaver is designed specifically for academic research. It relies on and incorporates references from _your_ Zotero library so you can curate the information used by Beaver. It also directly integrates into your reference manager for easy access directly where you work and read PDFs.

Here are some examples of the types of questions you might ask Beaver. In each case, the difference compared to ChatGPT, Claude etc is that Beaver will search _your_ library for relevant materials, correctly cite these materials and link back directly to the source document.

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

If the model requests a tool call, our servers execute the tool (e.g. searches for relevant Zotero items) and feed the results back to the model in a second request. This second request costs one more chat credit. A single request can generate multiple tool calls and each tool call costs an additional chat credit.

If you prefer, you can switch to using your own API key at any time. In that case, tool calls on our platform no longer consume chat credits—instead, you’ll pay your API provider directly according to their token-usage rates.

### How do the page limits work?

The page limits determine how many pages will be indexed for full-text search. If the size of your library exceeds the page limit, additional files will not be indexed for search. You can see any files that exceed the limit under "File Status" when starting a new thread.

Importantly, the page limit _only_ impacts full-text search! Metadata and related reference search is unlimited. You can also add documents that exceed your page balance manually to any chat. The document is just excluded from full-text search.

### What types of attachments are supported?

Currently, Beaver only supports PDF files. Additional file types will be supported later. Each plan also imposes limits on the number of pages and file size of each attachment.

### How can I improve the results?

Beaver explores your Zotero library using different search tools. When your library is disorganized, Beaver has a harder time finding the correct references and attachments.

Here are two concrete tips:

1. **Maintain a clean Zotero library**: Beaver searches your Zotero library, so maintaining a clean library helps a lot! For example, using clear filenames helps Beaver identify the right items and attachments. Using "main_article.pdf", "appendix.pdf" and "book_review.pdf" as filenames helps Beaver distinguish the different types of documents. In most cases this won't make a difference, but it is one example of countless ways in which Beaver relies on the data in your library.

2. **Use custom prompts**: Add details to the custom prompt under preferences. This text will be added to every conversation and helps Beaver understand your specific research context and preferences.

## System Requirements

- Zotero 7.0 or later
- Internet connection for cloud features
- Modern web browser for account management

## Is Beaver open source?

The Zotero plugin is open source and licensed under the [AGPL-3.0 License](LICENSE). The backend, server, and file processing code is not open source.
