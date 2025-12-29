import React from "react";
import { Spinner, ArrowRightIcon } from "../../icons/icons";
import Button from "../../ui/Button";

interface OnboardingFooterProps {
    /** Message displayed on the left side of the footer */
    message?: string;
    /** Button label text */
    buttonLabel: string;
    /** Whether the button action is in progress */
    isLoading?: boolean;
    /** Whether the button is disabled */
    disabled?: boolean;
    /** Click handler for the button */
    onButtonClick: () => void;
    /** Whether to show terms and privacy policy links */
    showTerms?: boolean;
}

/**
 * Shared footer component for onboarding pages
 * Displays optional terms links, a message, and an action button
 */
const OnboardingFooter: React.FC<OnboardingFooterProps> = ({
    message,
    buttonLabel,
    isLoading = false,
    disabled = false,
    onButtonClick,
    showTerms = false
}) => {
    return (
        <div className="p-4 border-top-quinary">
            <div className="display-flex flex-row items-center gap-4">
                {/* Terms and message area */}
                <div className="font-color-secondary text-sm">
                    {showTerms ? (
                        <>
                            {`By continuing, you agree to our `}
                            <a 
                                className="text-link cursor-pointer" 
                                onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/terms')}
                            >
                                Terms of Service
                            </a>
                            {` and `}
                            <a 
                                className="text-link cursor-pointer" 
                                onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/privacy-policy')}
                            >
                                Privacy Policy
                            </a>.
                        </>
                    ) : (
                        message
                    )}
                </div>

                <div className="flex-1" />

                {/* Action button */}
                <Button
                    variant="solid"
                    className="fit-content whitespace-nowrap"
                    rightIcon={isLoading ? Spinner : ArrowRightIcon}
                    onClick={onButtonClick}
                    disabled={disabled || isLoading}
                >
                    {buttonLabel}
                </Button>
            </div>
        </div>
    );
};

export default OnboardingFooter;

