import React from 'react';
import EmailToggle from '../../preferences/EmailToggle';
import HelpImproveBeaverToggle from '../../preferences/HelpImproveBeaverToggle';
import PreferenceToggle from '../../preferences/PreferenceToggle';


interface ConsentTogglesProps {
    agreedToTerms: boolean;
    handleTermsChange: (checked: boolean) => void;
    hasStarted: boolean;
    consentToShare: boolean;
    handleConsentChange: (checked: boolean) => void;
    emailNotifications: boolean;
    handleEmailNotificationsChange: (checked: boolean) => void;
}

/**
 * Consent toggles component for onboarding page
 * Shows terms and privacy policy agreement, help improve beaver toggle, and email notifications toggle
 */
const ConsentToggles: React.FC<ConsentTogglesProps> = ({
    agreedToTerms,
    handleTermsChange,
    hasStarted,
    consentToShare,
    handleConsentChange,
    emailNotifications,
    handleEmailNotificationsChange
}) => {
    return (
        <div className="display-flex flex-col gap-4">
            <div className="h-1 border-top-quinary" />
            
            {/* Terms and Privacy Policy Agreement */}
            <PreferenceToggle
                checked={agreedToTerms}
                onChange={handleTermsChange}
                disabled={hasStarted}
                title="Terms and Privacy Policy"
                subtitle="(required)"
                className="font-medium"
                description="I agree to the <a href='https://www.beaverapp.ai/terms' target='_blank' rel='noopener noreferrer'>Terms of Service</a> and <a href='https://www.beaverapp.ai/privacy-policy' target='_blank' rel='noopener noreferrer'>Privacy Policy</a>"
            />
            
            <HelpImproveBeaverToggle
                checked={consentToShare}
                onChange={handleConsentChange}
            />

            <EmailToggle
                checked={emailNotifications}
                onChange={handleEmailNotificationsChange}
            />
        </div>
    );
};

export default ConsentToggles;
