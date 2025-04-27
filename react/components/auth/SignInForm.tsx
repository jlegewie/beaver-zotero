import React, { useEffect } from 'react'
// @ts-ignore: React is defined
import { useState } from 'react'
import { supabase } from '../../../src/services/supabaseClient'
import Button from '../button'
import { getPref, setPref } from '../../../src/utils/prefs'

interface SignInFormProps {
    setErrorMsg: (errorMsg: string | null) => void;
    emailInputRef?: React.RefObject<HTMLInputElement>;
}

const SignInForm: React.FC<SignInFormProps> = ({ setErrorMsg, emailInputRef }) => {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [isLoading, setIsLoading] = useState(false)

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
            }
        } catch (err) {
            setErrorMsg('An unexpected error occurred')
        } finally {
            setIsLoading(false)
        }
    }
    
    return (
        <>
        <form onSubmit={handleSignIn} className="display-flex flex-col gap-3 w-full">
            {/* <h2 className="text-lg font-semibold text-center mb-2">Sign In</h2> */}
            
            <div className="display-flex flex-col gap-1">
                <label htmlFor="signInEmail" className="text-sm font-medium">Email</label>
                <input
                    id="signInEmail"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="border-quinary rounded-md p-2 bg-quaternary focus:border-tertiary transition outline-none"
                    placeholder="your.email@example.com"
                    ref={emailInputRef}
                />
            </div>
            
            <div className="display-flex flex-col gap-1">
                <label htmlFor="signInPassword" className="text-sm font-medium">Password</label>
                <input
                    id="signInPassword"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="border-quinary rounded-md p-2 bg-quaternary transition outline-none"
                    placeholder="••••••••"
                />
            </div>
            
            <div className="display-flex flex-row">
                <Button 
                    type="submit" 
                    variant="solid" 
                    className="mt-2 mb-2"
                    loading={isLoading}
                >
                    Sign In
                </Button>
            </div>
        </form>
        </>
    )
}

export default SignInForm
