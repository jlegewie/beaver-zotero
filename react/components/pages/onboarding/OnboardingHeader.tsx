import React from "react";

interface OnboardingHeaderProps {
    title?: string;
    message: string;
}

/**
 * Shared header component for onboarding pages
 * Displays the Beaver logo, welcome title, and a descriptive message
 */
const OnboardingHeader: React.FC<OnboardingHeaderProps> = ({
    title = "Welcome to Beaver",
    message
}) => {
    return (
        <div className="display-flex flex-col items-start mb-3">
            <div className="display-flex flex-row gap-2 items-end">
                <img 
                    src="chrome://beaver/content/icons/beaver.png" 
                    style={{ width: '4rem', height: '4rem' }} 
                    alt="Beaver logo"
                />
                <div className="text-2xl font-semibold mb-2">{title}</div>
            </div>
            <p className="text-base font-color-secondary" style={{ whiteSpace: 'pre-line' }}>
                {message}
            </p>
        </div>
    );
};

export default OnboardingHeader;

