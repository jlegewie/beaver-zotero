// Function to scroll to the bottom of the chat container
// const scrollToBottom = () => {
//   if (containerRef.current && !userScrolled) {
//     containerRef.current.scrollTop = containerRef.current.scrollHeight;
//   }
// };

export const scrollToBottom = (
    containerRef: React.RefObject<HTMLElement>,
    userScrolled: boolean
) => {
    // If user has manually scrolled, or container doesn't exist, don't auto-scroll
    if (!containerRef.current || userScrolled) {
        return;
    }
    
    const container = containerRef.current;
    const targetScrollTop = container.scrollHeight;
    const startScrollTop = container.scrollTop;
    const distance = targetScrollTop - startScrollTop;
    
    // If already at bottom or nearly at bottom, just jump there
    if (distance < 50) {
        container.scrollTop = targetScrollTop;
        return;
    }
    
    // Otherwise animate scroll with a faster duration
    // Animation duration based on distance (faster for shorter distances)
    const duration = Math.min(300, 100 + Math.sqrt(distance) * 5); 

    let start: number | null = null;

    const step = (timestamp: number) => {
        if (!start) start = timestamp;
        const progress = timestamp - start;
        const percentage = Math.min(progress / duration, 1);
        
        // Use easeOutQuad for smoother scrolling
        const eased = 1 - (1 - percentage) * (1 - percentage); 
        const scrollTop = startScrollTop + distance * eased;
        
        container.scrollTop = scrollTop;

        if (progress < duration) {
            Zotero.getMainWindow().requestAnimationFrame(step);
        }
    };

    Zotero.getMainWindow().requestAnimationFrame(step);
};
