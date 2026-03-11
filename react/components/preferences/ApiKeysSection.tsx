import React, { useState } from "react";
import {SettingsGroup, SectionLabel, DocLink} from "./components/SettingsElements";
import ApiKeyInput from "./ApiKeyInput";
import { getPref } from "../../../src/utils/prefs";
import { handlePrefSave } from "./utils";


const ApiKeysSection: React.FC = () => {

    // --- Atoms: API Keys ---
    const [geminiKey, setGeminiKey] = useState(() => getPref('googleGenerativeAiApiKey'));
    const [openaiKey, setOpenaiKey] = useState(() => getPref('openAiApiKey'));
    const [anthropicKey, setAnthropicKey] = useState(() => getPref('anthropicApiKey'));

    return (
        <>
            <SettingsGroup>
                <div className="display-flex flex-col gap-05 flex-1 min-w-0" style={{ padding: '8px 12px' }}>
                    {/* <div className="font-color-primary text-base font-medium">Permissions</div> */}
                    <div className="font-color-secondary text-base">
                        Beaver supports multiple model providers. Connect your API keys to use Gemini, Claude, or OpenAI models.
                        See our <DocLink path="api-key">API key guide</DocLink> or learn about <DocLink path="custom-models">additional providers and custom endpoints</DocLink>.
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
        
        </>
    );
};

export default ApiKeysSection;
