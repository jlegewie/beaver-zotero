/* eslint-disable no-undef */

// User ID and email
pref("userId", "");
pref("userEmail", "");
pref("currentPlanId", "");
pref("installedVersion", "");
pref("showIndexingCompleteMessage", false);
pref("authMethod", "otp");

// App settings
pref("keyboardShortcut", "l");
pref("statefulChat", true);
pref("addSelectedItemsOnOpen", true);
pref("addSelectedItemsOnNewThread", true);
pref("annotationToolEnabled", true);
pref("maxAddAttachmentToMessage", 3);

// Agent actions
pref("autoApplyAnnotations", true);
pref("autoImportItems", false);

// AI settings
pref("customInstructions", "");
pref("googleGenerativeAiApiKey", "");
pref("openAiApiKey", "");
pref("anthropicApiKey", "");
pref("lastUsedModel", "");
pref("customChatModels", "[]");

// Search
pref("recentItems", "[]");

// Citation format: author-year or numeric
pref("citationFormat", "numeric");
pref("citationStyle", "http://www.zotero.org/styles/chicago-author-date");
pref("citationLocale", "en-US");

// Custom Prompts (up to 9)
pref("customPrompts", '[ { "title": "Find related work in my library", "text": "What papers in my library are most relevant to this one? Identify similar methodologies, topics, or findings and explain the connections.", "librarySearch": true, "requiresAttachment": true }, { "title": "Highlight and annotate key findings", "text": "Add highlight annotations to the most important findings, evidence, and conclusions. Include brief notes explaining why each section matters.", "librarySearch": false, "requiresAttachment": true }, { "title": "Compare this to other studies", "text": "How do the findings here compare to similar research in my library? Identify agreements, contradictions, and gaps with sentence-level citations.", "librarySearch": true, "requiresAttachment": true }, { "title": "Generate follow-up research questions", "text": "Based on this paper\'s findings and limitations, propose 3-5 specific, testable research questions that would extend this work. Explain the rationale for each.", "librarySearch": false, "requiresAttachment": true }, { "title": "Create a structured summary with citations", "text": "Provide a detailed summary organized by: research question, methodology, key findings, limitations, and implications. Include sentence-level citations for each claim.", "librarySearch": false, "requiresAttachment": true } ]');

// Deletion jobs
pref("deletionJobs", "[]");

// Items skipped during sync
pref("skippedItems", "[]")

// Flags to show notifications, run consistency check and collection sync on upgrade
pref("runConsistencyCheck", false);
pref("runCollectionSync", false);
pref("runWebDAVSync", false);
pref("pendingVersionNotifications", "[]");

// Help message state (tracks dismissed messages and rate limiting)
pref("helpMessageState", "{}");
