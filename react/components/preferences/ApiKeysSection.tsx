import React, { useState, useCallback } from "react";
import Button from "../ui/Button";
import {SettingsGroup, SettingsRow, SectionLabel, DocLink} from "./components/SettingsElements";
import ApiKeyInput from "./ApiKeyInput";
import { getPref, setPref } from "../../../src/utils/prefs";
import { handlePrefSave } from "./utils";
import { activePreferencePageTabAtom, requestPlusToolsAtom } from "../../atoms/ui";
import { remainingBeaverCreditsAtom } from "../../atoms/profile";
import { useAtom, useAtomValue, useSetAtom } from "jotai";


const ApiKeysSection: React.FC = () => {
    const setActiveTab = useSetAtom(activePreferencePageTabAtom);

    // --- Atoms: API Keys ---
    const [geminiKey, setGeminiKey] = useState(() => getPref('googleGenerativeAiApiKey'));
    const [openaiKey, setOpenaiKey] = useState(() => getPref('openAiApiKey'));
    const [anthropicKey, setAnthropicKey] = useState(() => getPref('anthropicApiKey'));

    // --- Atoms: Request Plus Tools ---
    const [requestPlusTools, setRequestPlusTools] = useAtom(requestPlusToolsAtom);
    const remainingBeaverCredits = useAtomValue(remainingBeaverCreditsAtom);

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

            <SectionLabel>Additional Providers</SectionLabel>

            <div className="text-base font-color-secondary mt-1 mb-2" style={{ paddingLeft: '2px' }}>
                Additional model providers and custom endpoints are supported via <DocLink path="custom-models">custom models</DocLink>.
            </div>

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
        
        </>
    );
};

export default ApiKeysSection;
