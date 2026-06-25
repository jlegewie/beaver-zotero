import React, { useState, useCallback } from "react";
import Button from "../ui/Button";
import {SettingsGroup, SettingsRow, SectionLabel, DocLink, SectionHeader} from "./components/SettingsElements";
import ApiKeyInput from "./ApiKeyInput";
import CustomProviderCard from "./CustomProviderCard";
import PlusSignIcon from "../icons/PlusSignIcon";
import { getPref, setPref } from "../../../src/utils/prefs";
import { handlePrefSave } from "./utils";
import { activePreferencePageTabAtom, requestPlusToolsAtom } from "../../atoms/ui";
import { remainingBeaverCreditsAtom } from "../../atoms/profile";
import { refreshCustomModelsAtom } from "../../atoms/models";
import {
    CustomChatModel,
    getCustomChatModelsForEditing,
    saveCustomChatModelsToPreferences,
    OPENROUTER_API_BASE,
} from "../../types/settings";
import { useAtom, useAtomValue, useSetAtom } from "jotai";

/** Editor entry: a custom model plus a stable key for React list rendering. */
interface CustomProviderEntry {
    _id: string;
    model: CustomChatModel;
}

const createProviderId = (): string => crypto.randomUUID();

// New providers default to OpenRouter's endpoint, the most common custom setup.
const emptyCustomModel = (): CustomChatModel => ({
    name: '',
    snapshot: '',
    api_base: OPENROUTER_API_BASE,
    format: 'openai',
    api_key: '',
    supports_vision: false,
});

const ApiKeysSection: React.FC = () => {
    const setActiveTab = useSetAtom(activePreferencePageTabAtom);
    const refreshCustomModels = useSetAtom(refreshCustomModelsAtom);

    // --- Atoms: API Keys ---
    const [geminiKey, setGeminiKey] = useState(() => getPref('googleGenerativeAiApiKey'));
    const [openaiKey, setOpenaiKey] = useState(() => getPref('openAiApiKey'));
    const [anthropicKey, setAnthropicKey] = useState(() => getPref('anthropicApiKey'));

    // --- Atoms: Request Plus Tools ---
    const [requestPlusTools, setRequestPlusTools] = useAtom(requestPlusToolsAtom);
    const remainingBeaverCredits = useAtomValue(remainingBeaverCreditsAtom);

    // --- State: Custom Providers ---
    const [customProviders, setCustomProviders] = useState<CustomProviderEntry[]>(() =>
        getCustomChatModelsForEditing().map((model) => ({ _id: createProviderId(), model }))
    );
    // Only one provider card is expanded at a time.
    const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);

    // Persist the providers list to preferences and refresh the live model selector.
    const persistProviders = useCallback((entries: CustomProviderEntry[]) => {
        saveCustomChatModelsToPreferences(entries.map((e) => e.model));
        refreshCustomModels();
    }, [refreshCustomModels]);

    const handleAddProvider = useCallback(() => {
        const id = createProviderId();
        setCustomProviders((prev) => {
            const next = [...prev, { _id: id, model: emptyCustomModel() }];
            persistProviders(next);
            return next;
        });
        setExpandedProviderId(id);
    }, [persistProviders]);

    const handleProviderChange = useCallback((id: string, model: CustomChatModel) => {
        setCustomProviders((prev) => {
            const next = prev.map((e) => (e._id === id ? { ...e, model } : e));
            persistProviders(next);
            return next;
        });
    }, [persistProviders]);

    const handleRemoveProvider = useCallback((id: string) => {
        setCustomProviders((prev) => {
            const next = prev.filter((e) => e._id !== id);
            persistProviders(next);
            return next;
        });
        setExpandedProviderId((current) => (current === id ? null : current));
    }, [persistProviders]);

    // Insert a copy named "{name} (copy)" directly below the source and expand it.
    const handleDuplicateProvider = useCallback((id: string) => {
        const copyId = createProviderId();
        setCustomProviders((prev) => {
            const index = prev.findIndex((e) => e._id === id);
            if (index === -1) return prev;
            const source = prev[index].model;
            const copy: CustomChatModel = {
                ...source,
                name: `${source.name?.trim() || 'Untitled provider'} (copy)`,
            };
            const next = [...prev];
            next.splice(index + 1, 0, { _id: copyId, model: copy });
            persistProviders(next);
            return next;
        });
        setExpandedProviderId(copyId);
    }, [persistProviders]);

    const handleToggleExpand = useCallback((id: string) => {
        setExpandedProviderId((current) => (current === id ? null : id));
    }, []);

    // --- Handlers: Toggle Request Plus Tools ---
    const handleRequestPlusToolsToggle = useCallback(() => {
        const newValue = !requestPlusTools;
        setPref('requestPlusTools', newValue);
        setRequestPlusTools(newValue);
    }, [requestPlusTools]);

    return (
        <>
            <SectionHeader>API Keys and Model Providers</SectionHeader>
            <div className="display-flex flex-col gap-05 flex-1 min-w-0 py-1 mb-2">
                <div className="font-color-secondary text-base">
                    Connect your own API keys (see our <DocLink path="api-key">guide</DocLink>),
                    or add a <DocLink path="custom-models">custom endpoint</DocLink>. Free and new paid keys (Tier 1) keys often hit rate limits. A key with higher rate limits works best (Tier 2+).
                    <DocLink path="api-key#why-beaver-needs-more-from-your-api-key"> Why?</DocLink>
                </div>
            </div>

            {/* API Keys */}
            <SettingsGroup className="bg-senary">
                <div style={{ padding: '8px 12px' }}>
                    <ApiKeyInput
                        id="gemini-key"
                        label="Google API Key"
                        provider="google"
                        value={geminiKey}
                        onChange={setGeminiKey}
                        savePref={(newValue) => handlePrefSave('googleGenerativeAiApiKey', newValue)}
                        placeholder="Enter your Google AI Studio API Key"
                        linkUrl="https://aistudio.google.com/app/apikey"
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <ApiKeyInput
                        id="openai-key"
                        label="OpenAI API Key"
                        provider="openai"
                        value={openaiKey}
                        onChange={setOpenaiKey}
                        savePref={(newValue) => handlePrefSave('openAiApiKey', newValue)}
                        placeholder="Enter your OpenAI API Key"
                        linkUrl="https://platform.openai.com/api-keys"
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <ApiKeyInput
                        id="anthropic-key"
                        label="Anthropic API Key"
                        provider="anthropic"
                        value={anthropicKey}
                        onChange={setAnthropicKey}
                        savePref={(newValue) => handlePrefSave('anthropicApiKey', newValue)}
                        placeholder="Enter your Anthropic API Key"
                        linkUrl="https://console.anthropic.com/settings/keys"
                    />
                </div>
            </SettingsGroup>

            {/* Custom Providers */}
            <div>
                <div className="display-flex flex-row items-end justify-between">
                    <SectionLabel>Custom Providers</SectionLabel>
                    <Button
                        variant="outline"
                        icon={PlusSignIcon}
                        className="text-base mb-15"
                        onClick={handleAddProvider}
                    >
                        Add Provider
                    </Button>
                </div>

                <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                    OpenRouter, OpenAI-compatible proxies, or self-hosted HTTPS endpoints.
                    Requests are routed through Beaver's server. Each endpoint must be reachable from the public
                    internet over HTTPS.
                    {' '}<DocLink path="custom-models">Learn more</DocLink>
                </div>

                {customProviders.length > 0 ? (
                    <SettingsGroup className="bg-senary">
                        {customProviders.map((entry, index) => (
                            <CustomProviderCard
                                key={entry._id}
                                model={entry.model}
                                onChange={(model) => handleProviderChange(entry._id, model)}
                                onRemove={() => handleRemoveProvider(entry._id)}
                                onDuplicate={() => handleDuplicateProvider(entry._id)}
                                isExpanded={entry._id === expandedProviderId}
                                onToggleExpand={() => handleToggleExpand(entry._id)}
                                hasBorder={index > 0}
                            />
                        ))}
                    </SettingsGroup>
                ) : (
                    <div className="text-base font-color-tertiary" style={{ paddingLeft: '2px' }}>
                        No custom providers yet. Click <strong>Add Provider</strong> to configure one.
                    </div>
                )}
            </div>

            {/* Plus Tools */}
            <div className="display-flex flex-row gap-2">
                <SectionLabel>Plus Tools</SectionLabel>
                {requestPlusTools ? (
                    remainingBeaverCredits > 0 ? (
                        <span
                            className="text-sm font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary"
                            style={{
                                marginTop: '20px', marginBottom: '6px',
                                backgroundColor: 'var(--tag-green-quinary)',
                                color: 'var(--tag-green-secondary)',
                                borderColor: 'var(--tag-green-tertiary)',
                            }}
                        >
                            Active
                        </span>
                    ) : (
                        <span
                            className="text-sm font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary"
                            style={{
                                marginTop: '20px', marginBottom: '6px',
                                backgroundColor: 'var(--tag-orange-quinary)',
                                color: 'var(--tag-orange-secondary)',
                                borderColor: 'var(--tag-orange-tertiary)',
                            }}
                        >
                            Paused &middot; No credits
                        </span>
                    )
                ) : (
                    <span
                        className="text-sm font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary"
                        style={{ marginTop: '20px', marginBottom: '6px' }}
                    >
                        Inactive
                    </span>
                )}
            </div>
            <SettingsGroup className="bg-senary">
                {requestPlusTools && remainingBeaverCredits > 0 ? (
                    /* State 1: Enabled + has credits */
                    <SettingsRow
                        className="items-start"
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                Plus tools include external search, batch extraction, and AI ranking with your own key for improved performance.
                                {/* <DocLink path="credits">See the benchmarks</DocLink> */}
                                {' '}<DocLink path="credits">Learn more</DocLink>
                                <br /><br />
                                <span className="font-semibold font-color-primary text-lg">{remainingBeaverCredits.toLocaleString()}</span>
                                {' '}<span className="font-color-primary text-base">credits left</span> 
                                <br />
                                <span className="font-color-secondary text-sm">
                                    Just 0.25 credits per message. Some actions cost extra.
                                </span>
                            </>
                        }
                        control={
                            <Button variant="outline" className="mt-1" onClick={handleRequestPlusToolsToggle}>
                                Disable
                            </Button>
                        }
                    />
                ) : requestPlusTools && remainingBeaverCredits <= 0 ? (
                    /* State 2: Enabled + no credits */
                    <SettingsRow
                        className="items-start"
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                You're out of credits, so Plus tools are paused. Your API key still works for basic chat.
                                Add credits for external search, batch extraction, and AI ranking.
                                <br />
                                <br />
                                <Button variant="outline" className="mt-1" onClick={handleRequestPlusToolsToggle}>
                                    Disable Plus Tools
                                </Button>
                            </>
                        }
                        control={
                            <Button variant="solid" className="mt-1" onClick={() => setActiveTab('billing')}>
                                Get credits &rarr;
                            </Button>
                        }
                    />
                ) : !requestPlusTools && remainingBeaverCredits > 0 ? (
                    /* State 3: Disabled + has credits */
                    <SettingsRow
                        className="items-start"
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                Plus tools include external search, batch extraction, and AI ranking with your own key for improved performance.
                                {/* <DocLink path="credits">See the benchmarks</DocLink> */}
                                {' '}<DocLink path="credits">Learn more</DocLink>
                                <br /><br />
                                <span className="font-semibold font-color-primary text-lg">{remainingBeaverCredits.toLocaleString()}</span>
                                {' '}<span className="font-color-primary text-base">credits ready to use</span> 
                                <br />
                                <span className="font-color-secondary text-sm">
                                    Just 0.25 credits per message. Some actions cost extra.
                                </span>
                            </>
                        }
                        control={
                            <Button variant="solid" className="mt-1" onClick={handleRequestPlusToolsToggle}>
                                Enable
                            </Button>
                        }
                    />
                ) : (
                    /* State 4: Disabled + no credits */
                    <SettingsRow
                        className="items-start"
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                Plus tools include external search, batch extraction, and AI ranking with your own key for improved performance.
                                Costs 0.25 credits per message. Some actions cost extra.{' '}
                                <DocLink path="credits">Learn more</DocLink>
                            </>
                        }
                        control={
                            <Button variant="solid" className="mt-1" onClick={() => {handleRequestPlusToolsToggle(); setActiveTab('billing')}}>
                                Get credits &rarr;
                            </Button>
                        }
                    />
                )}
            </SettingsGroup>

        </>
    );
};

export default ApiKeysSection;
