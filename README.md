# Beaver 🦫

Welcome to Beaver! Beaver is your AI plugin for Zotero. What, another AI plugin for Zotero? Yes, indeed! But I think the feature set makes it compelling. There are other options and you should explore them all. They are great. Here is what makes Beaver special:

1. Seamlessly **integration into Zotero UI** as a side panel. Beaver is right there in Zotero and always knows what you are doing. Adding documents to Beaver is as easy as selecting them in the Zotero library. Reading an article in Zotero? Beaver knows which one it is and can even see the page you are on. This seamless integration makes it easy to ask question about your reference and allows for natural queries such as "Can you explain with super-duper complicated equation to me?" and Beaver knows what you are talking about.

2. **Powerfull search**. Beaver processes all of your attachments to enable hybrid search that uses both semantic similarity and keyword matching. This takes searching and findings documents to the next level. ...

3. **Agents and deep research** (beta). I love agents

4. **MPC server** (beta). Connect with other tools. You prefer the claude web-interface? Simply coneect our Zotero MPC sever and Claude suddenly has access too your full Zotero library including hybrid search. That means you can use Claude's deep research to...

5. **Evaluations**: Beaver uses evaluations to improve performance. You might not see what as a user but it drives the quality of your results by prompt engerineering, improving search quality and turning roughly 100 other knobs to eke out performance. Admittedly, we are not where we hope to be but we are getting there.

6. **Evaluations**:

7. **What's the catch**: It's not free! Sorry. But there will be a free plan. See here for details.

## Common questions

### Why does Beaver cost money and yet it suggest using my own API key?

Great question!

Using LLMs with long context (i.e. your research articles) is expensive. We can include these costs in the subscription but it would get much more expensive. And

It puts your interest and our interest in direct conflict: ...token...

Here is our solution: Your subscription covers everything else (storage, document processing, search, tool use etc) and the cost of a cheap but surprisingly great model (Gemini Flash 2.0) at a reasonable rate. Just add your own key to use any model from OpenAi, Anthropic or Google!

### Will there be a Free plan?

Yes, absolutely dedicated to that. Work has already started. Timing depends a little on how launch goes. Exeact feature set is not clear. It will either be 100% local or with reduced featured through our servers (more likely). The plan will support using your own key to make unlimited chat completions. Document processing will not be supported but some form of search will. Details also depend on the cost of running servers.

You can keep track of any progress at this github issue. Feel free to share your thoughts and suggestions:

### How can I improve the results?

Here are some tips:

1. Maybe most importantly, Beaver works with your zotero library. Maintaining a clean library helps lot!

For example, using clear filenames helps Beaver identify the right items and attachments. For example, using "main_article.pdf" and "appendix.pdf" are filename helps Beaver distinguish the two documents. In most cases this will not make a difference but it's one example of countless ways in which Beaver relies on the data in your library. If you library is a mess, Beaver will still be useful but will not be able to correct any errors in the underlying bibliographic data.

2. Custom prompts.

3. Learn when to use which tool (normal chat versus agent)

### What is the difference between normal chat and agent?

Normal chat … You can use library search with normal chat. In that case, the program first searches the full text of your Zotero library and then provides attachments or parts of attachments to the model. Your query is used directly and anything that matches your query is dumped into the context. Very effect for...

Agent allows the model to use search (and other tools) interactively. Agent is best suited for complex quires, multi-step instructions or cases in which you want a deep exploration of the literature in your library.

Let’s look at some example:

1. Queries: “Can you summarize this article for me” or “please explain the equation on page 4”.
   Recommendation: Always use normal chat without library search. Simple attach the relevant document to the chat.
2. Queries: “Summarize research on …”
   Recommendation: Normal chat with library search
3. Queries: "Identify key findings in this article and search for other articles that either support or contradict the findings”.
   Recommendation. This is a query that requires multi step reasoning. The model first has to identify the key findings and then conduct a separate search for each of them. Normal chat would not be able...

### Is Beaver open source?

The Zotero plugin is open source and available here (link). The license is permissive for personal use with limitations on competing products. The backend, server code is not open source.
