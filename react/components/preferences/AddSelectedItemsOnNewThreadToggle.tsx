import React from "react";
import PreferenceToggle from "./PreferenceToggle";
import { getPref, setPref } from "../../../src/utils/prefs";

interface AddSelectedItemsOnNewThreadToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
}

const AddSelectedItemsOnNewThreadToggle: React.FC<AddSelectedItemsOnNewThreadToggleProps> = ({ checked, onChange }) => {
    const handleChange = (newValue: boolean) => {
        setPref("addSelectedItemsOnNewThread", newValue);
        onChange(newValue);
    };

    return (
        <PreferenceToggle
            checked={checked}
            onChange={handleChange}
            title="Add Selected Items to New Threads"
            description="Automatically include items selected in Zotero when creating a new chat thread."
            tooltip="When enabled, any items you have selected in Zotero will be automatically added as sources when you start a new conversation thread."
        />
    );
};

export default AddSelectedItemsOnNewThreadToggle; 