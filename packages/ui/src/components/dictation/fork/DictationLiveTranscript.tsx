// FORK: show committed segment text without changing final transcript insertion.
import React from 'react';

export const DictationLiveTranscript: React.FC<{ text: string }> = ({ text }) => {
    const transcriptRef = React.useRef<HTMLDivElement | null>(null);

    React.useLayoutEffect(() => {
        const transcript = transcriptRef.current;
        if (transcript) {
            transcript.scrollTop = transcript.scrollHeight;
        }
    }, [text]);

    if (!text) return null;

    return (
        <div
            ref={transcriptRef}
            className="typography-meta mt-1 max-h-[3lh] overflow-y-auto whitespace-pre-wrap break-words text-foreground"
            aria-live="polite"
        >
            {text}
        </div>
    );
};
