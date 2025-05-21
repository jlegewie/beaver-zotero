import React, { useEffect } from 'react'
// @ts-ignore: React is defined
import { useState } from 'react'
import { supabase } from '../../../src/services/supabaseClient'
import Button from '../button'
import { getPref, setPref } from '../../../src/utils/prefs'
import { accountService } from '../../../src/services/accountService'
import { isProfileLoadedAtom, profileWithPlanAtom } from '../../atoms/profile'
import { useSetAtom } from 'jotai'

interface SignInFormProps {
    setErrorMsg: (errorMsg: string | null) => void;
    emailInputRef?: React.RefObject<HTMLInputElement>;
}

const SignInForm: React.FC<SignInFormProps> = ({ setErrorMsg, emailInputRef }) => {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const setIsProfileLoaded = useSetAtom(isProfileLoadedAtom);
    const setProfileWithPlan = useSetAtom(profileWithPlanAtom);

    useEffect(() => {
        emailInputRef?.current?.focus();
    }, []);
    
    const handleSignIn = async (e: React.FormEvent) => {
        e.preventDefault()
        setErrorMsg(null)
        setIsLoading(true)

        // Check if Zotero instance is already associated with another account
        const storedUserEmail = getPref("userEmail");
        if (storedUserEmail && storedUserEmail !== email) {
            setErrorMsg(`This Zotero instance is already associated with another Beaver account. Please sign in with the correct account (${storedUserEmail}).`);
            setIsLoading(false)
            return;
        }

        // Sign in with password
        try {
            const { data, error } = await supabase.auth.signInWithPassword({ email, password })
            if (error) {
                setErrorMsg(error.message)
            }
            else {
                setPref("userId", data.user.id);
                setPref("userEmail", data.user.email ?? "");
                
                // Fetch user profile
                try {
                    const fetchedProfileWithPlan = await accountService.getProfileWithPlan();
                    if(!fetchedProfileWithPlan) {
                        supabase.auth.signOut();
                        setErrorMsg('Failed to load profile data. Try again later.');
                        return;
                    }
                    setProfileWithPlan(fetchedProfileWithPlan);
                    setIsProfileLoaded(true);
                } catch (profileError) {
                    setErrorMsg('Failed to load profile data. Try again later.');
                    supabase.auth.signOut();
                } finally {
                    setIsLoading(false);
                }
            }
        } catch (err) {
            setErrorMsg('An unexpected error occurred')
        } finally {
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
                </Button>
            </div>
        </form>
        </>
    )
}

export default SignInForm
