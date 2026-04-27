import React, { useState } from "react";
import SignInForm from "../auth/SignInForm";
import { Icon, LockIcon } from "../icons/icons";
import { getPref } from "../../../src/utils/prefs";

interface LoginPageProps {
    emailInputRef?: React.RefObject<HTMLInputElement>;
}

const LoginPage: React.FC<LoginPageProps> = ({ emailInputRef }) => {
    const [errorMsg, setErrorMsg] = useState<string | null>(null)
    // Show first-time privacy disclosure on the sign-in form until acknowledged
    const [showOnboardingText] = useState<boolean>(() => !getPref("onboardingSignInTextShown"))

    return (
        <div 
            id="login-page"
            className="display-flex flex-col flex-1 min-h-0 overflow-y-auto scrollbar min-w-0 py-4 px-4"
        >
            <div style={{ height: '1rem' }}></div>
            <div className="webapp-max-w-md webapp-mx-auto w-full">
                {/* Header section */}
                <div className="mb-8 text-center">
                    <img src="chrome://beaver/content/icons/beaver.png" style={{ width: '4.5rem', height: '4.5rem' }} />
                    <div className="webapp-text-3xl webapp-font-bold font-color-primary mb-2">Beaver</div>
                    <div className="font-color-secondary">Sign in to your account</div>
                </div>
                
                {/* Form container */}
                <div className="webapp-space-y-6">
                    <SignInForm setErrorMsg={setErrorMsg} emailInputRef={emailInputRef} />
                </div>

                {/* {errorMsg && (
                    <div className="mt-8">
                        <p className="text-sm font-color-red text-center">{errorMsg}</p>
                    </div>
                )} */}
            </div>
            <div className="flex-1"/>
            {showOnboardingText && (
                <div className="display-flex flex-row gap-3 items-start bg-quinary p-2 rounded-lg">
                    <Icon icon={LockIcon} className="mt-020 scale-11" />
                    <span>
                        Signing in lets Beaver read your library.
                        We securely process extracted text to answer questions, but never upload or permanently store your original files.
                        <a
                            className="text-link cursor-pointer ml-1"
                            href={process.env.WEBAPP_BASE_URL + '/docs/privacy'}
                            onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/docs/privacy')}
                            target='_blank'
                            rel='noopener noreferrer'
                        >
                            Learn more
                        </a>
                    </span>
                </div>
            )}
        </div>
    );
};

export default LoginPage;