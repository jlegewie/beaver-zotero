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
            className="display-flex flex-col flex-1 min-h-0 overflow-y-auto scrollbar min-w-0 p-4"
        >
            <div style={{ height: '5vh' }}></div>
            <div className="display-flex flex-col justify-center max-w-md mx-auto w-full">
                {/* Header section */}
                <div className="display-flex flex-col items-start mb-4">
                    <h1 className="text-2xl font-semibold">Welcome to Beaver 🦫</h1>
                    <p className="text-base font-color-secondary -mt-2">Your AI plugin for Zotero.</p>
                </div>
                
                {/* Form container with subtle background */}
                <div className="w-90 rounded-lg border-quinary p-4 bg-quaternary">
                    <SignInForm setErrorMsg={setErrorMsg} emailInputRef={emailInputRef} />
                    
                </div>
                {/* Additional links */}
                <div className="display-flex flex-col gap-2 mt-4 text-sm">
                    {/* <a href="#" className="font-color-tertiary hover:font-color-primary transition">Forgot password?</a> */}
                    <div className="display-flex gap-1">
                        <span className="font-color-tertiary">Don't have an account?</span>
                        <a
                            href="#"
                            className="font-color-secondary hover:font-color-primary transition"
                            style={{textDecoration: 'none'}}
                            onMouseEnter={(e) => e.currentTarget.style.textDecoration = 'underline'}
                            onMouseLeave={(e) => e.currentTarget.style.textDecoration = 'none'}
                        >
                            Sign up
                        </a>
                    </div>
                </div>

                {errorMsg && (
                    <p className="text-sm font-color-red text-center">{errorMsg}</p>
                )}
            </div>
        </div>
    );
};

export default LoginPage;