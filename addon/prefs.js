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

// Custom Prompts (up to 9)
pref("customPrompts", '[ { "title": "Organize my recent additions into collections", "text": "Review the papers I added in the last two weeks. Check what collections I have, then help me file these items into the appropriate existing collections based on their topics.", "librarySearch": false, "requiresAttachment": false }, { "title": "Review and fix metadata", "text": "Check my 10 most recently added items for missing or incomplete metadata especially DOIs, publication info, and abstracts. Look up the correct information and help me fix any issues.", "librarySearch": false, "requiresAttachment": false }, { "title": "Find related work in my library", "text": "What papers in my library are most relevant to this one? Identify similar methodologies, topics, or findings and explain the connections.", "librarySearch": true, "requiresAttachment": true }, { "title": "Highlight and annotate key findings", "text": "Add highlight annotations to the most important findings, evidence, and conclusions. Include brief notes explaining why each section matters.", "librarySearch": false, "requiresAttachment": true, "requiresDatabaseSync": true }, { "title": "Compare this to other studies", "text": "How do the findings here compare to similar research in my library? Identify agreements, contradictions, and gaps.", "librarySearch": true, "requiresAttachment": true } ]');

// Deletion jobs
pref("deletionJobs", "[]");

// Items skipped during sync
pref("skippedItems", "[]")

// Flags to show notifications, run consistency check and collection sync on upgrade
pref("runConsistencyCheck", false);
pref("runCollectionSync", false);
pref("runWebDAVSync", false);
pref("pendingVersionNotifications", "[]");
