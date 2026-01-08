import React from "react";

interface OnboardingHeaderProps {
    title?: string;
    message: string | React.ReactNode;
    tag?: string
}

/**
 * Shared header component for onboarding pages
 * Displays the Beaver logo, welcome title, and a descriptive message
 */
const OnboardingHeader: React.FC<OnboardingHeaderProps> = ({
    title = "Welcome to Beaver",
    message,
    tag
}) => {
    return (
        <div className="display-flex flex-col items-start mb-3">
            <div className="display-flex flex-row gap-2 items-end">
                <img 
                    src="chrome://beaver/content/icons/beaver.png" 
                    style={{ width: '4rem', height: '4rem' }} 
                    alt="Beaver logo"
                />
                <div className="display-flex flex-row gap-1 items-center">
                <div className="text-2xl font-semibold mb-2">{title}</div>
                    {tag && (
                        <div className="font-color-secondary scale-90 px-15 py-05 mb-3 text-sm rounded-md bg-quinary border-quinary">
                            {tag}
                        </div>
                    )}
                </div>
            </div>
            {typeof message === 'string' ? (
                <p className="text-base font-color-secondary" style={{ whiteSpace: 'pre-line' }}>
                    {message}
                </p>
            ) : (
                message
            )}
        </div>
    );
};

export default OnboardingHeader;

