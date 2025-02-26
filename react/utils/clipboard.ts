/**
 * Options for the copyToClipboard function
 */
interface CopyToClipboardOptions {
  /** Callback function that runs after successful copying */
  onSuccess?: (text: string) => void;
  /** Callback function that runs if copying fails */
  onError?: (error: Error) => void;
}

/**
 * Copies text to the clipboard
 * 
 * @param text The text to copy
 * @param options Optional callbacks for success/error
 * @returns A promise that resolves when copying is complete
 */
export async function copyToClipboard(
  text: string, 
  options: CopyToClipboardOptions = {}
): Promise<boolean> {
  const { onSuccess, onError } = options;
  
  try {
    await navigator.clipboard.writeText(text);
    
    if (onSuccess) {
      onSuccess(text);
    }
    
    return true;
  } catch (error) {
    if (onError) {
      onError(error as Error);
    }
    
    return false;
  }
} 