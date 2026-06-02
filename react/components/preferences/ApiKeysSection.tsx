import React, { useState, useCallback } from "react";
import Button from "../ui/Button";
import {SettingsGroup, SettingsRow, SectionLabel, DocLink} from "./components/SettingsElements";
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
            <SettingsGroup>
                <div className="display-flex flex-col gap-05 flex-1 min-w-0" style={{ padding: '8px 12px' }}>
                    {/* <div className="font-color-primary text-base font-medium">Permissions</div> */}
                    <div className="font-color-secondary text-base">
                        Beaver supports multiple model providers. Connect your API keys to use Gemini, Claude, or OpenAI models.
                        See our <DocLink path="api-key">API key guide</DocLink> or learn about <DocLink path="custom-models">additional providers and custom endpoints</DocLink>.
                    </div>

                    <div className="font-color-secondary text-base mt-1">                                                                                                                                                                                                                                              
                        <strong>Heads up:</strong> Free API keys and new paid keys (Tier 1) often hit rate limits in Beaver because each question uses much more of your quota than a normal chat. A key with higher rate limits works best (Tier 2+). <DocLink path="api-key#why-beaver-needs-more-from-your-api-key">Learn why</DocLink>.                                    
                    </div>
                </div>
            </SettingsGroup>

            <SettingsGroup>
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

            <div className="display-flex flex-row gap-2">
                <SectionLabel>Plus Tools</SectionLabel>
                {requestPlusTools ? (
                    remainingBeaverCredits > 0 ? (
                        <span
                            className="text-xs font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary"
                            style={{ marginTop: '20px', marginBottom: '6px' }}
                        >
                            Enabled
                        </span>
                    ) : (
                        <span
                            className="text-xs px-15 py-05 rounded-md"
                            style={{ marginTop: '20px', marginBottom: '6px', color: 'var(--tag-orange-secondary)', border: '1px solid var(--tag-orange-tertiary)', background: 'var(--tag-orange-quinary)' }}
                        >
                            Paused &middot; No credits
                        </span>
                    )
                ) : (
                    <span
                        className="text-xs font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary"
                        style={{ marginTop: '20px', marginBottom: '6px' }}
                    >
                        Disabled
                    </span>
                )}
            </div>
            <SettingsGroup>
                {requestPlusTools && remainingBeaverCredits > 0 ? (
                    /* State 1: Enabled + has credits */
                    <SettingsRow
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                Enable to use Plus Tools like external search, batch extraction, and AI ranking with your own API key.
                                Costs 0.25 credits per message. Some actions cost extra.{' '}
                                <DocLink path="credits">Learn more</DocLink>
                                <br />
                                <br />
                                <span className="font-color-secondary">
                                    You have {remainingBeaverCredits.toLocaleString()} credits available.
                                </span>
                            </>
                        }
                        control={
                            <Button variant="outline" onClick={handleRequestPlusToolsToggle}>
                                Disable
                            </Button>
                        }
                    />
                ) : requestPlusTools && remainingBeaverCredits <= 0 ? (
                    /* State 2: Enabled + no credits */
                    <SettingsRow
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                Plus Tools are enabled but can't run without credits.
                                Your API key will still work for basic chat.
                                <br />
                                <br />
                                <span className="text-link cursor-pointer" onClick={() => setActiveTab('billing')}>
                                    Get credits &rarr;
                                </span>
                            </>
                        }
                        control={
                            <Button variant="outline" onClick={handleRequestPlusToolsToggle}>
                                Disable
                            </Button>
                        }
                    />
                ) : !requestPlusTools && remainingBeaverCredits > 0 ? (
                    /* State 3: Disabled + has credits */
                    <SettingsRow
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                Unlock external search, batch extraction, and AI ranking alongside your API key.
                                Costs 0.25 credits per message. Some actions cost extra.{' '}
                                <DocLink path="credits">Learn more</DocLink>
                                <br />
                                <br />
                                <span className="font-color-secondary">
                                    You have {remainingBeaverCredits.toLocaleString()} credits available.
                                </span>
                            </>
                        }
                        control={
                            <Button variant="outline" onClick={handleRequestPlusToolsToggle}>
                                Enable
                            </Button>
                        }
                    />
                ) : (
                    /* State 4: Disabled + no credits */
                    <SettingsRow
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                Unlock external search, batch extraction, and AI ranking alongside your API key.
                                Costs 0.25 credits per message. Some actions cost extra.{' '}
                                <DocLink path="credits">Learn more</DocLink>
                                <br />
                                <br />
                                <span className="text-link cursor-pointer" onClick={() => setActiveTab('billing')}>
                                    Get credits &rarr;
                                </span>
                            </>
                        }
                    />
                )}
            </SettingsGroup>

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
                Connect OpenRouter, OpenAI-compatible proxies, or self-hosted endpoints as additional models.
                Requests are routed through Beaver's backend, so each endpoint must be reachable from the public
                internet over HTTPS — localhost, private networks, and VPN-only hosts will not work.
                {' '}<DocLink path="custom-models">Learn more</DocLink>.
            </div>

            {customProviders.length > 0 ? (
                <SettingsGroup>
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

        </>
    );
};

export default ApiKeysSection;
