import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Blob } from '@google/genai';
import { InterviewStatus, TranscriptTurn } from './types';
import { SYSTEM_INSTRUCTION } from './constants';
import AudioVisualizer from './AudioVisualizer';


// --- Helper Functions for Audio Processing ---
const encode = (bytes: Uint8Array): string => {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const decode = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

const decodeAudioData = async (
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> => {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
};

const createBlob = (data: Float32Array): Blob => {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
};


// --- UI Components defined outside App to prevent re-renders ---

const MicrophoneIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM11 5a1 1 0 0 1 2 0v8a1 1 0 0 1-2 0V5Z" />
    <path d="M12 15a5 5 0 0 0 5-5V5a5 5 0 0 0-10 0v5a5 5 0 0 0 5 5ZM8 5a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0V5Z" />
    <path d="M12 18a.5.5 0 0 1 .5.5v1.082l.992.825a.5.5 0 0 1-.6.8l-1.002-.83A.5.5 0 0 1 12 20h-.01a.5.5 0 0 1-.38-.19l-1.002.83a.5.5 0 1 1-.6-.8l.992-.825V18.5A.5.5 0 0 1 12 18Z" />
    <path d="M12 16.5a1 1 0 0 1 1 1v2.086l1.354 1.128a1 1 0 0 1-.708 1.708L12 19.586l-1.646 1.836a1 1 0 0 1-.708-1.708L11 19.586V17.5a1 1 0 0 1 1-1Z" />
  </svg>
);

const TranscriptView: React.FC<{ transcript: TranscriptTurn[] }> = ({ transcript }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
      {transcript.map((turn) => (
        <div key={turn.timestamp} className={`flex items-start gap-4 ${turn.speaker === 'user' ? 'justify-end' : 'justify-start'}`}>
          {turn.speaker === 'model' && (
            <div className="w-10 h-10 rounded-full bg-indigo-500 flex-shrink-0 flex items-center justify-center font-bold">GD</div>
          )}
          <div className={`max-w-xl p-4 rounded-2xl ${turn.speaker === 'user' ? 'bg-blue-600 rounded-br-none' : 'bg-gray-700 rounded-bl-none'}`}>
            <p className="text-white leading-relaxed">{turn.text}</p>
          </div>
          {turn.speaker === 'user' && (
             <div className="w-10 h-10 rounded-full bg-gray-600 flex-shrink-0 flex items-center justify-center font-bold">You</div>
          )}
        </div>
      ))}
    </div>
  );
};

// --- Main App Component ---

const App: React.FC = () => {
  const [status, setStatus] = useState<InterviewStatus>(InterviewStatus.IDLE);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [error, setError] = useState<string | null>(null);

  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  const stopInterview = useCallback(async () => {
    setStatus(InterviewStatus.ENDED);
    
    if (sessionPromiseRef.current) {
      const session = await sessionPromiseRef.current;
      session.close();
      sessionPromiseRef.current = null;
    }

    if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current = null;
    }
    if (mediaStreamSourceRef.current) {
        mediaStreamSourceRef.current.disconnect();
        mediaStreamSourceRef.current = null;
    }

    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }

    if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
      await inputAudioContextRef.current.close();
    }
    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
      audioSourcesRef.current.forEach(source => source.stop());
      audioSourcesRef.current.clear();
      await outputAudioContextRef.current.close();
    }

    setTranscript(prev => [...prev, { speaker: 'model', text: 'Interview ended.', isFinal: true, timestamp: Date.now() }]);
  }, []);

  const startInterview = useCallback(async () => {
    setStatus(InterviewStatus.CONNECTING);
    setError(null);
    setTranscript([]);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      analyserRef.current = outputAudioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 128;

      nextStartTimeRef.current = 0;
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });

      sessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(InterviewStatus.LISTENING);
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            mediaStreamSourceRef.current = source;
            const scriptProcessor = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              if (sessionPromiseRef.current) {
                sessionPromiseRef.current.then((session) => {
                  session.sendRealtimeInput({ media: pcmBlob });
                });
              }
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              setTranscript(prev => {
                const newTranscript = [...prev];
                const lastTurn = newTranscript[newTranscript.length - 1];
                if (lastTurn && lastTurn.speaker === 'model' && !lastTurn.isFinal) {
                  lastTurn.text += text;
                } else {
                  newTranscript.push({ speaker: 'model', text, isFinal: false, timestamp: Date.now() });
                }
                return newTranscript;
              });
            } else if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
               setTranscript(prev => {
                const newTranscript = [...prev];
                const lastTurn = newTranscript[newTranscript.length - 1];
                if (lastTurn && lastTurn.speaker === 'user' && !lastTurn.isFinal) {
                  lastTurn.text += text;
                } else {
                  newTranscript.push({ speaker: 'user', text, isFinal: false, timestamp: Date.now() });
                }
                return newTranscript;
              });
            }
             if (message.serverContent?.turnComplete) {
                setTranscript(prev => prev.map(t => ({ ...t, isFinal: true })));
             }
            
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current && analyserRef.current) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContextRef.current.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContextRef.current, 24000, 1);
              const source = outputAudioContextRef.current.createBufferSource();
              source.buffer = audioBuffer;
              
              source.connect(analyserRef.current);
              analyserRef.current.connect(outputAudioContextRef.current.destination);
              
              source.addEventListener('ended', () => audioSourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(source);
            }
             if (message.serverContent?.interrupted) {
                audioSourcesRef.current.forEach(source => source.stop());
                audioSourcesRef.current.clear();
                nextStartTimeRef.current = 0;
             }
          },
          onerror: (e: ErrorEvent) => {
            setError(`Connection error: ${e.message}`);
            setStatus(InterviewStatus.ERROR);
            stopInterview();
          },
          onclose: (e: CloseEvent) => {
            // This can be called when stopInterview is called, so check status
            if (status !== InterviewStatus.ENDED) {
               stopInterview();
            }
          },
        },
      });
    } catch (err) {
      if (err instanceof Error) {
        setError(`Failed to start interview: ${err.message}`);
      } else {
        setError('An unknown error occurred.');
      }
      setStatus(InterviewStatus.ERROR);
    }
  }, [stopInterview, status]);
  
  useEffect(() => {
    return () => {
      if (status !== InterviewStatus.IDLE && status !== InterviewStatus.ENDED) {
        stopInterview();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleInterview = () => {
    if (status === InterviewStatus.LISTENING) {
      stopInterview();
    } else {
      startInterview();
    }
  };

  const getButtonState = () => {
    switch (status) {
      case InterviewStatus.IDLE:
      case InterviewStatus.ENDED:
      case InterviewStatus.ERROR:
        return { text: 'Start Interview', disabled: false };
      case InterviewStatus.CONNECTING:
        return { text: 'Connecting...', disabled: true };
      case InterviewStatus.LISTENING:
        return { text: 'Stop Interview', disabled: false };
      default:
        return { text: 'Start Interview', disabled: false };
    }
  };

  const buttonState = getButtonState();

  return (
    <div className="flex flex-col h-screen bg-gray-900 font-sans">
      <header className="p-4 border-b border-gray-700 shadow-lg text-center">
        <h1 className="text-2xl font-bold text-white tracking-wider">AI Interview Candidate: Garry David</h1>
        <p className="text-sm text-gray-400">You are the interviewer. Powered by Gemini 2.5 Native Audio</p>
      </header>
      
      <main className="flex-1 flex flex-col min-h-0">
         {transcript.length === 0 && status !== InterviewStatus.CONNECTING && (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
                <div className="max-w-md">
                    <h2 className="text-3xl font-bold text-white mb-2">Start the Interview</h2>
                    <p className="text-gray-400 mb-6">
                        You are the interviewer. When you're ready, click "Start Interview" below to begin your conversation with Garry David (the AI). Ask him questions about the experience listed on his resume.
                    </p>
                </div>
            </div>
         )}
        <TranscriptView transcript={transcript} />
        {error && <div className="p-4 text-center text-red-400 bg-red-900/50">{error}</div>}
      </main>

      <footer className="p-4 border-t border-gray-700 bg-gray-900/80 backdrop-blur-sm">
        <div className="flex items-center justify-center space-x-4">
          <div className="relative w-28 h-28 flex items-center justify-center">
             <AudioVisualizer analyserNode={analyserRef.current} isListening={status === InterviewStatus.LISTENING} />
             <button 
                onClick={handleToggleInterview} 
                disabled={buttonState.disabled}
                className={`relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 focus:outline-none focus:ring-4 focus:ring-indigo-500/50 ${
                    status === InterviewStatus.LISTENING ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'
                } ${buttonState.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {status === InterviewStatus.LISTENING && (
                    <span className="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-75"></span>
                )}
                <MicrophoneIcon className="h-8 w-8 text-white"/>
              </button>
          </div>
        </div>
         <p className="text-center text-gray-500 text-sm mt-1">{buttonState.text}</p>
      </footer>
    </div>
  );
};

export default App;
