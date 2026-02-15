/* eslint-disable no-undef */

// User ID and email
pref("userId", "");
pref("userEmail", "");
pref("currentPlanId", "");
pref("installedVersion", "");
pref("showIndexingCompleteMessage", false);
pref("showHighTokenUsageWarningMessage", true);
pref("authMethod", "otp");

// App settings
pref("keyboardShortcut", "j");
pref("statefulChat", true);
pref("addSelectedItemsOnOpen", true);
pref("addSelectedItemsOnNewThread", true);
pref("annotationToolEnabled", true);
pref("maxAddAttachmentToMessage", 3);

// Beaver Free file limits
pref("maxFileSizeMB", 50);
pref("maxPageCount", 300);

// Agent actions
pref("autoApplyAnnotations", true);
pref("autoImportItems", false);

// Deferred tool preferences: maps tool group to preference (always_ask, always_apply, continue_without_applying)
// toolToGroup maps tool names to group names (allows renaming tools while preserving preference)
// groupPreferences maps group names to the actual preference value
pref("deferredToolPreferences", '{"toolToGroup":{"edit_metadata":"metadata_edits","edit_item":"metadata_edits","create_collection":"library_modifications","organize_items":"library_modifications","create_item":"create_items","create_items":"create_items"},"groupPreferences":{"metadata_edits":"always_ask","create_items":"always_ask","library_modifications":"always_ask"}}');

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

// Custom Prompts (versioned format: { version, prompts }; each prompt has a stable id)
pref("customPrompts", '{ "version": 2, "prompts": [ { "id": "default-organize-collections", "title": "Organize my recent additions into collections", "text": "Review the papers I added in the last two weeks. Check what collections I have, then help me file these items into the appropriate existing collections based on their topics.", "librarySearch": false, "requiresAttachment": false, "shortcut": 1 }, { "id": "default-review-metadata", "title": "Review and fix metadata", "text": "Check my 10 most recently added items for missing or incomplete metadata especially DOIs for journal articles, publication info, and abstracts. Look up the correct information and help me fix any issues.", "librarySearch": false, "requiresAttachment": false, "shortcut": 2 }, { "id": "default-find-related", "title": "Find related work in my library", "text": "What papers in my library are most relevant to this one? Identify similar methodologies, topics, or findings and explain the connections.", "librarySearch": true, "requiresAttachment": true, "shortcut": 3 }, { "id": "default-highlight-annotate", "title": "Highlight and annotate key findings", "text": "Add highlight annotations to the most important findings, evidence, and conclusions. Include brief notes explaining why each section matters.", "librarySearch": false, "requiresAttachment": true, "requiresDatabaseSync": true, "shortcut": 4 }, { "id": "default-compare-studies", "title": "Compare this to other studies", "text": "How do the findings here compare to similar research in my library? Identify agreements, contradictions, and gaps.", "librarySearch": true, "requiresAttachment": true, "shortcut": 5 } ] }');

// Deletion jobs
pref("deletionJobs", "[]");

// Items skipped during sync
pref("skippedItems", "[]")

// Flags to show notifications, run consistency check and collection sync on upgrade
pref("runConsistencyCheck", false);
pref("runCollectionSync", false);
pref("runWebDAVSync", false);
pref("runEmbeddingFullDiff", false);
pref("pendingVersionNotifications", "[]");
