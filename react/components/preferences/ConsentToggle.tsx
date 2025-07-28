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
            description="Share your prompts and queries to help us improve Beaver. Your files and personal information are never shared and your data is anonymized."
            tooltip="When enabled, we use your prompts, queries, and AI responses to improve Beaver's features and performance. We automatically remove personal information and never share your PDFs, documents, or other files. You can change this setting anytime."
        />
    );
};

export default ConsentToggle;