/* eslint-disable no-undef */
pref("enable", true);
pref("input", "This is input");
// API keys
pref("voyageApiKey", "");
pref("googleGenerativeAiApiKey", "");
pref("openAiApiKey", "");
pref("anthropicApiKey", "");
pref("lastUsedModel", "");
pref("supportedModelsLastFetched", "");
pref("supportedModels","[]");

// Citation format: author-year or numeric
pref("citationFormat", "author-year");
pref("citationStyle", "http://www.zotero.org/styles/chicago-author-date");
pref("citationLocale", "en-US");
pref("keyboardShortcut", "l");
// Operation mode: 'cloud' or 'local'
pref("mode", "cloud");
// Custom instructions for chat
pref("customInstructions", "");

// Quick Prompts (up to 6)
pref("quickPrompt1_title", "Detailed summary");
pref("quickPrompt1_text", "Provide a detailed and structured summary of the article.");
pref("quickPrompt1_librarySearch", false);
pref("quickPrompt1_requiresAttachment", true);

pref("quickPrompt2_title", "Short summary");
pref("quickPrompt2_text", "Provide a short summary of the article.");
pref("quickPrompt2_librarySearch", false);
pref("quickPrompt2_requiresAttachment", true);

pref("quickPrompt3_title", "Propose testable hypotheses");
pref("quickPrompt3_text", "Generate testable hypotheses for future research that build on and follow up on the article. The hypotheses should be specific and testable. Describe each hypothesis in a separate paragraph.");
pref("quickPrompt3_librarySearch", false);
pref("quickPrompt3_requiresAttachment", true);

pref("quickPrompt4_title", "Compare key findings to other studies");
pref("quickPrompt4_text", "Compare the key findings of the article with the findings of other studies in the literature. Discuss the similarities and differences between the findings of the article and the findings of other studies.");
pref("quickPrompt4_librarySearch", true);
pref("quickPrompt4_requiresAttachment", true);

pref("quickPrompt5_title", "");
pref("quickPrompt5_text", "");
pref("quickPrompt5_librarySearch", false);
pref("quickPrompt5_requiresAttachment", false);

pref("quickPrompt6_title", "");
pref("quickPrompt6_text", "");
pref("quickPrompt6_librarySearch", false);
pref("quickPrompt6_requiresAttachment", false);