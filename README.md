# ![](/addon/content/icons/beaver_nomargin.png) Beaver

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Welcome to Beaver! Beaver is your AI plugin for Zotero designed by academic reseachers to help with the research process. What, another AI plugin for Zotero? Yes, indeed! But I think the feature set makes it compelling. There are other options and you should explore them all. They are great. Here are some things that make Beaver special:

1. Seamless **integration into Zotero Library and PDF Reader** as a side panel. Beaver is right there in Zotero and always knows what you are doing. Reading an article in Zotero? Beaver knows which one it is and can see the page you are on. This seamless integration makes it easy to ask question about your references and allows for natural queries such as "Can you explain this super-duper complicated equation to me?" and Beaver knows what you are talking about.

2. **Metadata and related reference search**. Beaver can search your entire library by metadata (author, year, title) or for reference related to a specific topic (semantic search). All 100% free, without limits.

3. **Full-text search**. Beaver processes all of your attachments (up to a page limit) for it's most powerful search tool: full-text search over your entire library. Depending on your plan, it uses either keyword search or hybrid search that combines keyword matching with semantic search.

4. Beaver is **agentic**. That means Beaver can iteratively search your library using different search strategies to find relevant information.

5. Feature-rich **free version**: We have a feature packed free version with unlimited metadata and related item search, free processing of medium sized libraries for keyword search und unlimited use with your own API keys.

6. Advanced **payed version**: To unable all features such as advanced file processing, powerful hybrid search for large libraries and more, we have paid versions.

<!-- 5. **MPC server** (beta). Connect with other tools. You prefer the claude web-interface? Simply coneect our Zotero MPC sever and Claude suddenly has access too your full Zotero library including hybrid search. That means you can use Claude's deep research to... -->

## How does Beaver work?

Beaver syncs your entire library with our servers, prepares your library for metadata and related reference search and processes your files for full-text search all in the cloud. We have a strict [privacy policy](...) in place and are working on additional features that allows you to keep key data locally. If you prefer a local solution, we suggest one of the many Zotero plugins such as [A.R.I.A.](https://github.com/lifan0127/ai-research-assistant).

## How does library search work?

Library search is important to understand how Beaver works and the differences between the free and payed plans. Beaver uses agentic search, which means that the large language model has access to different search tools and can decide when to use which type of search. Currently, Beaver has access to three search tools (with more planed in the future):

1. **Metadata search**: Metadata search searches for Zotero items by metadata such as author, year or title. This search allows the model to find specific references either because you ask for articles by a specific author or because it determined that a specific reference is important based on other papers.

- Free plan: Unlimited across your entire Zotero library.
- Payed plans: Unlimited across your entire Zotero library.

2. **Related reference search**: Related reference search searches for Zotero items based on semantic similarity. It allows the model to find all references related to a specific topic based on semantic similarity. For example, searching for "crime" will find articles that are related to the topic regardless of whether or not they use the word "crime" in the title or abstract.

- Free plan: Unlimited across your entire Zotero library.
- Payed plans: Unlimited across your entire Zotero library.

3. **Fulltext search**: Fulltext search is the most powerful search tool that requires document processing and is the only search that distinguishes the free from the paid plans:

   - Keyword search (Free plan): The free plan uses fulltext, keyword search for all documents that were processed up to the plan limit (currently 50,000 pages for the free plan). Keyword search is similar to Zotero's build in fulltext search. Beaver improves on that with additional processing and by splitting documents into pages, which allows the model to better cite specific parts of articles. Keyword search is powerful particularily with an AI system that is optimized to formulate good keyword search terms. I mean, who types this in the search bar: `("education" OR "school achievement" OR "academic performance") AND ("socioeconomic status" OR "poverty" OR "income inequality" OR "class background")`

   - Hybrid search (Paid plans): The paid plans usees hybrid search that combines keyword search with semantic search. Hybrid search can retrieve parts of document based either on keyword matching or on semantic similarity. Hybrid search is generally considered as the state of the art search approach in RAG applications.

   - Advanced hybrid search (Unlimited plan): The unlimited plan further improves on the results from hybrid search. This includes (among other things) using seperate models for reranking the search results, which can greatly improve the relevance of search results.

Together, these search tools allow the research agent to iteratively explore your library and find relevant references or documents.

## Responsible use of Generative AI in academic research and writing

The use of generative AI in academic research is a hotly debated topic (see one discussion [here](https://statmodeling.stat.columbia.edu/2025/07/18/i-am-no-longer-chairing-defenses-or-joining-committees-where-students-use-generative-ai-for-their-writing/#comments)). Everyone using these tools should engage with these question and understand that there are very different views. As the developer of Beaver, we want to highlight some things that we think are important for using generative AI tools such as Beaver for academic research and writing.

First and foremost, students should talk with your advisor, committee, mentor, department or other relevant people about how and when you are allowed to use generative AI. Rules will differ and it is important to be upfront to avoid any misunderstand later on. Many university, departments, journals, publishers etc have rules and guidelines. Make sure you are familiar with them.

Second, we are excited about the potential that generative AI brings to the research process. We believe that using generative AI responsibly can empower students and researchers to do better work. This includes using generative AI as a tutor that helps you understand complicated concepts, as a research assistant that searches for and compiles relevant references, and as a brainstorming partner that can rely on your entire Zotero library. Beaver and generative AI provides 24/7 access too all this and much more even when you don't have access to tutors, patenient instructors or the funds to hire a research assistant. Here are just some examples of the type of questions that you might ask Beaver or any other generative AI tool such as ChatGPT:

- I don't understand the difference between "legal cynicism" and "legal estrangement". Can you search my library to find clear definitions and discuss how the two terms are used in empirical research?
- What are the key findings in this article and how do they relate to other research? Identify the key findings and then search for other research that either supports or contradicts the key findings.
- Has any research looked at the interaction between
- (Zotero PDF reader) This article seems to use cross-validation for
- (Zotero PDF reader) Why do they control for income in their model? Does other research on the same topic do that as well?
- (Zotero PDF reader) The measure of wealth doesn't make sense to me. How do other studies measure wealth?
- (Zotero PDF reader, planed feature) This article is way to complicated for me. Can you add annotation to every equation with a simple explanation of each term?
- (Zotero PDF reader, planed feature) I received my article for copy-editing. Can you go through every page, make sure everything is correct and add annotations to any gramitical, spelling, formatting or other error?

## Common questions

### What is the difference between Beaver and any other generative AI tool such as ChatGPT?

Beaver is designed for academic research. It relies on and incorperates references from _your_ Zotero library so you can curate the information used by Beaver. In also directly integrates in your reference manager for easy access directly were your work and read PDFs.

### Do you store and use my data?

Beaver syncs your data with our server, uploads your attachment files and processes your attachments in the cloud to provide all the functionality. We have a detailed (and strict) privacy policy [here](...). In short, your data is protected by our security measures, separated from other users and will not be sold or used for model training. The only exception are the free chat credits included in the testing and free plan. They are free but we have permission to use the chat conversation to improve Beaver including the design of evaluations, fine-tuning or model training. Just add your own API key (including in the free or testing plan!) or subscribe and your data will not be used for model training.

In addition, we are working on features that will allow you to store all your chats locally (Zotero data will still be synced).

If you prefer local solutions, take a look at other Zotero plug ins such as [A.R.I.A.](https://github.com/lifan0127/ai-research-assistant).

### Why does Beaver cost money and it wants me to use my own API key?

Great question!

Using LLMs with long context (i.e. your research articles) is expensive. We can include these costs in the subscription but it would get much more expensive. The "Core" plan intentionally provides the core functionality of Beaver (storage, document processing, search, tool use etc) with limited AI credits so you can use your own API key to freely choose your model and only pay for what you need. If you want a plan that includes unlimited AI usage for Gemini 2.5 Flash and plenty of credits for frontier models, select the "Unlimited" plan.

## How do the page limits work?

The page limits determine how many pages will be indexed for full-text search. If the size of your library exceeds the page limit, additional files will not be indexed for search. You can see any files that exceed the limit on the under "File Status" when starting a new thread.

Importantly, the page limit _only_ impacts full-text search! Metadata and related reference search is unlimited. You can also add documents that exceed your page balance manually to any chat. The AI just can not find the document when using full-text search.

## What type of attachments are supported?

Currently, Beaver only supports PDF files. Additional file types will be supported later. Each plan also imposes limits on the number of pages and file size of each attachment.

## How can I improve the results?

Beaver explores your Zotero library using different search tools. When your library is a mess, Beaver has a harder time finding the correct references and attachments.

Here are two concrete tips:

1. Beaver searches your zotero library. Maintaining a clean library helps lot!

For example, using clear filenames helps Beaver identify the right items and attachments. For example, using "main_article.pdf" and "appendix.pdf" as filename helps Beaver distinguish the two documents. In most cases this will not make a difference but it's one example of countless ways in which Beaver relies on the data in your library.

2. Custom prompts. Add details to the custom prompt under preferences. This text will be added to every...

<!-- ### What is the difference between normal chat and agent?

Normal chat … You can use library search with normal chat. In that case, the program first searches the full text of your Zotero library and then provides attachments or parts of attachments to the model. Your query is used directly and anything that matches your query is dumped into the context. Very effect for...

Agent allows the model to use search (and other tools) interactively. Agent is best suited for complex quires, multi-step instructions or cases in which you want a deep exploration of the literature in your library.

Let’s look at some example:

1. Queries: “Can you summarize this article for me” or “please explain the equation on page 4”.
   Recommendation: Always use normal chat without library search. Simple attach the relevant document to the chat.
2. Queries: “Summarize research on …”
   Recommendation: Normal chat with library search
3. Queries: "Identify key findings in this article and search for other articles that either support or contradict the findings”.
   Recommendation. This is a query that requires multi step reasoning. The model first has to identify the key findings and then conduct a separate search for each of them. Normal chat would not be able... -->

## Is Beaver open source?

The Zotero plugin is open source and available in this repro. The backend, server and file processing code is not open source.
