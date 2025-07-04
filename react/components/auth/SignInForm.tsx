import React, { useEffect, useState } from 'react'
import { supabase } from '../../../src/services/supabaseClient'
import Button from '../ui/Button'
import { getPref, setPref } from '../../../src/utils/prefs'
import { useAtomValue, useSetAtom } from 'jotai'
import { isProfileLoadedAtom, isProfileInvalidAtom } from '../../atoms/profile'

const PROFILE_LOAD_TIMEOUT = 10000; // 10 second timeout

interface SignInFormProps {
    setErrorMsg: (errorMsg: string | null) => void;
    emailInputRef?: React.RefObject<HTMLInputElement>;
}

const SignInForm: React.FC<SignInFormProps> = ({ setErrorMsg, emailInputRef }) => {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [isWaitingForProfile, setIsWaitingForProfile] = useState(false)
    const isProfileLoaded = useAtomValue(isProfileLoadedAtom)
    const isProfileInvalid = useAtomValue(isProfileInvalidAtom)
    const setIsProfileInvalid = useSetAtom(isProfileInvalidAtom)

    useEffect(() => {
        emailInputRef?.current?.focus();
    }, []);

    // Prefill email if stored email exists
    useEffect(() => {
        const storedUserEmail = getPref("userEmail");
        if (storedUserEmail) {
            setEmail(storedUserEmail);
        }
    }, []);

    // Add timeout for profile loading
    useEffect(() => {
        if (isWaitingForProfile) {
            const timeout = setTimeout(() => {
                if (!isProfileLoaded) {
                    setErrorMsg('Failed to load profile data. Try again later.');
                    supabase.auth.signOut();
                    setIsWaitingForProfile(false);
                    setIsLoading(false);
                }
            }, PROFILE_LOAD_TIMEOUT);

            return () => clearTimeout(timeout);
        }
    }, [isWaitingForProfile, isProfileLoaded, setErrorMsg]);

    // Handle successful profile loading
    useEffect(() => {
        if (isWaitingForProfile && isProfileLoaded) {
            setIsWaitingForProfile(false);
            setIsLoading(false);
        }
    }, [isWaitingForProfile, isProfileLoaded]);

    // Handle profile invalid state (Zotero instance mismatch)
    useEffect(() => {
        if (isProfileInvalid) {
            setErrorMsg('This Zotero instance is not linked to your account. Please try signing in from the correct Zotero instance.');
            setIsWaitingForProfile(false);
            setIsLoading(false);
        }
    }, [isProfileInvalid, setErrorMsg]);
    
    const handleSignIn = async (e: React.FormEvent) => {
        e.preventDefault()
        setErrorMsg(null)
        setIsLoading(true)
        setIsProfileInvalid(false);

        // Check if Zotero instance is already associated with another account
        const storedUserEmail = getPref("userEmail");
        if (storedUserEmail && storedUserEmail.toLowerCase() !== email.toLowerCase()) {
            setErrorMsg(`This Zotero instance is already associated with another Beaver account. Please sign in with the correct account (${storedUserEmail}).`);
            setIsLoading(false)
            return;
        }

        // Sign in with password
        try {
            const { data, error } = await supabase.auth.signInWithPassword({ email, password })
            if (error) {
                setErrorMsg(error.message)
                setIsLoading(false)
            } else {
                
                // Wait for useProfileSync to fetch the profile
                setIsWaitingForProfile(true);
                // isLoading will be set to false when profile loads or timeout occurs
            }
        } catch (err) {
            setErrorMsg('An unexpected error occurred')
            setIsLoading(false)
        }
    }
    
    return (
        <>
        <form onSubmit={handleSignIn} className="display-flex flex-col gap-5 w-full my-2">
            {/* <div className="text-2xl font-semibold text-center mb-2">Login</div> */}
            
            <div className="display-flex flex-col gap-2">
                <label htmlFor="signInEmail" className="text-sm font-medium">Email</label>
                <input
                    id="signInEmail"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="border-quinary rounded-md -ml-05 p-2 bg-quaternary focus:border-tertiary transition outline-none"
                    placeholder="your.email@example.com"
                    ref={emailInputRef}
                />
            </div>
            
            <div className="display-flex flex-col gap-2">
                <div className="display-flex flex-row gap-2 flex-1">
                    <label htmlFor="signInPassword" className="text-sm font-medium">Password</label>
                    <div className="flex-1" />
                    {/* <div className="text-sm font-color-tertiary">
                        <a
                            href="#"
                            className="font-color-tertiary hover:font-color-primary transition"
                            style={{textDecoration: 'none'}}
                            onMouseEnter={(e) => e.currentTarget.style.textDecoration = 'underline'}
                            onMouseLeave={(e) => e.currentTarget.style.textDecoration = 'none'}
                        >
                            Forgot password?
                        </a>
                    </div> */}
                </div>
                <input
                    id="signInPassword"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="border-quinary rounded-md -ml-05 p-2 bg-quaternary transition outline-none"
                    placeholder="••••••••"
                />
            </div>
            
            <div className="display-flex flex-row">
                <Button 
                    type="submit" 
                    variant="solid" 
                    className="scale-11 ml-05"
                    loading={isLoading}
                    disabled={email=="" || password==""}
                >
                    Login
                    {/* {isWaitingForProfile ? 'Loading profile...' : 'Login'} */}
                </Button>
            </div>
        </form>
        </>
    )
}

export default SignInForm
