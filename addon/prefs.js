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
pref("autoCreateNotes", true);
pref("autoImportItems", false);
pref("autoApproveExtraction", false);
pref("autoApproveExternalSearch", false);

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
// Variables supported in prompt text: {{recent_items}}, {{recent_item}}, {{open_attachment}}, {{active_item}}, {{selected_items}}, {{current_collection}}
pref("customPrompts", '{ "version": 2, "prompts": [ { "id": "default-fit-research", "title": "How does this paper fit into my library?", "text": "How does this paper connect to the rest of my library? Does it support, challenge, or extend ideas in papers I already have? Write a short report that directly compares the paper to other research in my library including a comparison table. Use a Zotero note attached to the item.{{active_item}}", "requiresAttachment": false, "shortcut": 1 }, { "id": "default-discover-missing", "title": "What recent research am I missing?", "text": "Based on the topics of these recently added papers, search for external references that I might be missing. Focus on papers from the last two years that are relevant to my main research areas.{{recent_items}}", "requiresAttachment": false, "shortcut": 2 }, { "id": "default-organize-collections", "title": "Organize my recent additions", "text": "Review the papers I added in the last two weeks. Check what collections I have, then help me file these items into the appropriate existing collections based on their topics.", "requiresAttachment": false, "shortcut": 3 }, { "id": "default-review-metadata", "title": "Review and fix metadata", "text": "Check my 10 most recently added items for missing or incomplete metadata — especially DOIs for journal articles, publication info, and abstracts. Look up the correct information and help me fix any issues.", "requiresAttachment": false, "shortcut": 4 } ] }');

// Separate storage for prompt lastUsed timestamps (keyed by prompt id)
// Kept outside customPrompts so using a prompt doesn't dirty the main pref default
pref("customPromptsLastUsed", "{}");

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
