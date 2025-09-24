import React from "react";

interface PreferenceToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    error?: boolean;
    title: string;
    description: string;
    tooltip?: string;
    disabledTooltip?: string;
    errorTooltip?: string;
    showRecommended?: boolean;
    recommendedText?: string;
    errorText?: string;
}

const PreferenceToggle: React.FC<PreferenceToggleProps> = ({
    checked,
    onChange,
    disabled = false,
    error = false,
    title,
    description,
    tooltip,
    disabledTooltip,
    errorTooltip,
    showRecommended = false,
    recommendedText = "Recommended",
    errorText = "Error"
}) => {
    const handleToggle = () => {
        onChange(!checked);
    };

    const getTooltip = () => {
        if (disabled && disabledTooltip) {
            return disabledTooltip;
        }
        return tooltip;
    };

    return (
        <div
            className={`display-flex flex-col rounded-md ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
            onClick={disabled ? undefined : handleToggle}
            title={getTooltip()}
        >
            <div className="display-flex flex-row gap-2 items-start">
                <input
                    type="checkbox" 
                    className={`mr-1 scale-90 ${showRecommended ? 'mt-15' : 'mt-020'}`}
                    style={{minWidth: 'auto'}}
                    checked={checked}
                    onChange={handleToggle}
                    onClick={(e) => e.stopPropagation()}
                    disabled={disabled}
                />

                <div className="display-flex flex-col gap-05">
                    <div className="display-flex flex-col items-start">
                        <div className="display-flex flex-row gap-2 items-center">
                            <div className="font-color-primary text-base">
                                {title}
                            </div>
                            {!disabled && !error && showRecommended && (
                                <div className="font-color-secondary scale-90 px-15 py-05 mt-015 text-sm rounded-md bg-quinary border-quinary">
                                    {recommendedText}
                                </div>
                            )}
                            {error && (
                                <div
                                    className="scale-90 px-15 py-05 mt-020 text-sm rounded-md bg-quinary border-error"
                                    style={{ color: 'var(--tag-red-secondary)', borderColor: 'var(--tag-red-tertiary)', background: 'var(--tag-red-quinary)' }}
                                    title={errorTooltip}
                                >
                                    {errorText}
                                </div>
                            )}
                        </div>
                        <div className="font-color-secondary text-sm">
                            {description}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PreferenceToggle; 