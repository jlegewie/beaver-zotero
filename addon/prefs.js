/* eslint-disable no-undef */

// User ID and email
pref("userId", "");
pref("userEmail", "");
pref("currentPlanId", "");
pref("showIndexingCompleteMessage", false);

// App settings
pref("keyboardShortcut", "l");
pref("updateSourcesFromZoteroSelection", false);
pref("statefulChat", true);

// AI settings
pref("maxAttachments", 8);
pref("customInstructions", "");
pref("googleGenerativeAiApiKey", "");
pref("openAiApiKey", "");
pref("anthropicApiKey", "");
pref("lastUsedModel", "");

// Search
pref("recentItems", "[]");

// Citation format: author-year or numeric
pref("citationFormat", "author-year");
pref("citationStyle", "http://www.zotero.org/styles/chicago-author-date");
pref("citationLocale", "en-US");

// Custom Prompts (up to 9)
pref("customPrompts", '[ { "title": "Detailed summary", "text": "Provide a detailed and structured summary of the article.", "librarySearch": false, "requiresAttachment": true }, { "title": "Short summary", "text": "Provide a short summary of the article.", "librarySearch": false, "requiresAttachment": true }, { "title": "Propose testable hypotheses", "text": "Generate testable hypotheses for future research that build on and follow up on the article. The hypotheses should be specific and testable. Describe each hypothesis in a separate paragraph.", "librarySearch": false, "requiresAttachment": true }, { "title": "Compare key findings to other studies", "text": "Compare the key findings of the article with the findings of other studies in the literature. Discuss the similarities and differences between the findings of the article and the findings of other studies.", "librarySearch": true, "requiresAttachment": true } ]');
