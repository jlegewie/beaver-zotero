import React from "react";
import PreferenceToggle from "./PreferenceToggle";

interface HelpImproveBeaverToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
}

const HelpImproveBeaverToggle: React.FC<HelpImproveBeaverToggleProps> = ({ checked, onChange }) => {
    return (
        <PreferenceToggle
            checked={checked}
            onChange={onChange}
            title="Help Improve Beaver"
            subtitle="(optional)"
            description="Share anonymized prompts to help improve Beaver"
            tooltip="When enabled, we use your prompts, queries, and AI responses to improve Beaver's features and performance. We automatically remove personal information and never share your PDFs, documents, or other files. You can change this setting anytime."
        />
    );
};

export default HelpImproveBeaverToggle;