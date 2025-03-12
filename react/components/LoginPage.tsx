import React from "react";
// @ts-ignore: React is defined
import { useState } from 'react'
import SignInForm from "./auth/SignInForm";

const LoginPage: React.FC = () => {
    const [errorMsg, setErrorMsg] = useState<string | null>(null)

    return (
        <div 
            id="beaver-welcome"
            className="flex flex-col flex-1 min-h-0 overflow-y-auto scrollbar min-w-0 p-4"
        >
            <div className="flex flex-col items-center justify-center max-w-md mx-auto w-full">
                {/* Logo and header section */}
                <div className="flex flex-col items-center mb-4 mt-6">
                    <div className="mb-2">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="var(--fill-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            <path d="M2 17L12 22L22 17" stroke="var(--fill-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            <path d="M2 12L12 17L22 12" stroke="var(--fill-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                    </div>
                    <h1 className="text-lg font-semibold">Beaver for Zotero</h1>
                    {/* <p className="text-sm font-color-tertiary mt-1">Sign in to access advanced features</p> */}
                </div>
                
                {/* Form container with subtle background */}
                <div className="w-90 rounded-lg border-quinary p-4 bg-quaternary">
                    <SignInForm setErrorMsg={setErrorMsg} />
                    
                    {/* Additional links */}
                    {/* <div className="flex flex-col items-center gap-2 mt-4 text-sm">
                        <a href="#" className="font-color-tertiary hover:font-color-primary transition">Forgot password?</a>
                        <div className="flex items-center gap-1">
                            <span className="font-color-tertiary">Don't have an account?</span>
                            <a href="#" className="font-color-secondary hover:font-color-primary transition">Register</a>
                        </div>
                    </div> */}
                </div>

                {errorMsg && (
                    <p className="text-sm font-color-red text-center">{errorMsg}</p>
                )}
                
                {/* Footer */}
                {/* <div className="mt-4 text-xs font-color-tertiary text-center">
                    <p>Beaver ...</p>
                </div> */}
            </div>
        </div>
    );
};

export default LoginPage;