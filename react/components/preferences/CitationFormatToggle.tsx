import React from "react";
import { getPref, setPref } from "../../../src/utils/prefs";

interface CitationFormatToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
}

const CitationFormatToggle: React.FC<CitationFormatToggleProps> = ({ checked, onChange }) => {
    const handleToggle = () => {
        const newFormat = checked ? "author-year" : "numeric";
        setPref("citationFormat", newFormat);
        onChange(!checked);
    };

    return (
        <div
            className="display-flex flex-col rounded-md cursor-pointer"
            onClick={handleToggle}
            title="Switch between author-year (e.g., Smith, 2023) and numeric (e.g., [1]) citation formats"
        >
            <div className="display-flex flex-row gap-2 items-start">
                <input
                    type="checkbox" 
                    className="mr-1 scale-90 mt-020"
                    style={{minWidth: 'auto'}}
                    checked={checked}
                    onChange={handleToggle}
                    onClick={(e) => e.stopPropagation()}
                />

                <div className="display-flex flex-col gap-05">
                    <div className="display-flex flex-col gap-1 items-start">
                        <div className="display-flex flex-row gap-2 items-center">
                            <div className="font-color-primary text-base">
                                Citation Format: {checked ? "Numeric" : "Author-Year"}
                            </div>
                        </div>
                        <div className="font-color-secondary text-sm">
                            Choose between numeric [1] or author-year (Smith, 2023) citations
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default CitationFormatToggle; 