import React from "react";
import PreferenceToggle from "./PreferenceToggle";

interface ConsentToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
}

const ConsentToggle: React.FC<ConsentToggleProps> = ({ checked, onChange }) => {
    return (
        <PreferenceToggle
            checked={checked}
            onChange={onChange}
            title="Help Improve Beaver"
            description="Help improve Beaver by sharing your prompts. Your files stay private, and data is anonymized."
            tooltip="When enabled, we use your prompts, queries, and AI responses to improve Beaver's features and performance. We automatically remove personal information and never share your PDFs, documents, or other files. You can change this setting anytime."
        />
    );
};

export default ConsentToggle;