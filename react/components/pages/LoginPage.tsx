import React, { useState } from "react";
import SignInForm from "../auth/SignInForm";

interface LoginPageProps {
    emailInputRef?: React.RefObject<HTMLInputElement>;
}

const LoginPage: React.FC<LoginPageProps> = ({ emailInputRef }) => {
    const [errorMsg, setErrorMsg] = useState<string | null>(null)

    return (
        <div 
            id="login-page"
            className="display-flex flex-col flex-1 min-h-0 overflow-y-auto scrollbar min-w-0 py-4 px-4"
        >
            <div style={{ height: '1rem' }}></div>
            <div className="webapp-max-w-md webapp-mx-auto w-full">
                {/* Header section */}
                <div className="mb-8 text-center">
                    <img src="chrome://beaver/content/icons/beaver.png" style={{ width: '5rem', height: '5rem' }} />
                    <div className="webapp-text-3xl webapp-font-bold font-color-primary mb-2">Welcome back</div>
                    <p className="font-color-secondary">Sign in to your Beaver account</p>
                </div>
                
                {/* Form container */}
                <div className="webapp-space-y-6">
                    <SignInForm setErrorMsg={setErrorMsg} emailInputRef={emailInputRef} />
                </div>
                
                {/* Additional links */}
                <div className="mt-8 text-center">
                    <p className="font-color-secondary">
                        Don&apos;t have an account?{' '}
                        <span
                            onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/join')}
                            className="webapp-link font-medium"
                        >
                            Get started
                        </span>
                    </p>
                </div>

                {/* {errorMsg && (
                    <div className="mt-8">
                        <p className="text-sm font-color-red text-center">{errorMsg}</p>
                    </div>
                )} */}
            </div>
        </div>
    );
};

export default LoginPage;