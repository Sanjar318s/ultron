"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The Web Speech API's SpeechRecognition isn't in TS's DOM lib yet, and
// only exists behind the webkit-prefixed name in some browsers.
interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}
interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

function getRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

// Voice ID: "male" → DmitryNeural, "female" → SvetlanaNeural.
export type VoiceId = "male" | "female";
const VOICE_STORAGE_KEY = "ultron-voice-id";

export interface VoiceHandlers {
  /** Called for every final recognized phrase — the raw transcript. */
  onHear?(transcript: string): void;
}

export interface VoiceApi {
  supported: boolean;
  listening: boolean;
  speaking: boolean;
  /** Current voice selection (persisted in localStorage). */
  voiceId: VoiceId;
  /** Switch voice between "male" and "female". */
  setVoice(id: VoiceId): void;
  /** Speak a line out loud (Edge TTS with browser fallback). */
  speak(text: string): void;
  start(): void;
  stop(): void;
  toggle(): void;
}

// ---------------------------------------------------------------------------
// Browser TTS fallback (used when Edge TTS server is unreachable)
// ---------------------------------------------------------------------------

function speakBrowser(
  text: string,
  seq: number,
  speakSeqRef: React.MutableRefObject<number>,
  setSpeaking: (v: boolean) => void,
  wasListening: boolean,
  listeningRef: React.MutableRefObject<boolean>,
  suppressRestartRef: React.MutableRefObject<boolean>,
  start: () => void,
) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const synth = window.speechSynthesis;
  synth.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ru-RU";
  utterance.rate = 0.9;
  utterance.pitch = 0.75;

  const pickVoice = () => {
    const ru = synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith("ru"));
    if (ru.length === 0) return null;
    const maleHints = ["pavel", "vladimir", "boris", "dmitri", "mikhail", "mihail", "male"];
    return (
      ru.find((v) => /pavel/i.test(v.name)) ??
      ru.find((v) => maleHints.some((h) => v.name.toLowerCase().includes(h))) ??
      ru[0]
    );
  };
  const applyVoice = () => {
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
  };
  applyVoice();
  if (synth.getVoices().length === 0) {
    synth.addEventListener("voiceschanged", applyVoice, { once: true });
  }

  const resume = () => {
    if (speakSeqRef.current !== seq) return;
    setSpeaking(false);
    suppressRestartRef.current = false;
    if (wasListening && listeningRef.current) {
      setTimeout(() => {
        if (listeningRef.current) start();
      }, 400);
    }
  };
  utterance.onstart = () => {
    if (speakSeqRef.current === seq) setSpeaking(true);
  };
  utterance.onend = resume;
  utterance.onerror = resume;
  synth.speak(utterance);
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

/**
 * Raw speech I/O: continuous Russian recognition (Web Speech API) + Edge TTS
 * (Microsoft neural voices) with browser TTS fallback.
 */
export function useVoiceCommands(handlers: VoiceHandlers): VoiceApi {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const listeningRef = useRef(false);
  const suppressRestartRef = useRef(false);
  const speakSeqRef = useRef(0);

  const [supported] = useState(() => getRecognitionCtor() !== null);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voiceId, setVoiceIdState] = useState<VoiceId>(() => {
    if (typeof window === "undefined") return "male";
    return (localStorage.getItem(VOICE_STORAGE_KEY) as VoiceId) || "male";
  });

  const setVoice = useCallback((id: VoiceId) => {
    setVoiceIdState(id);
    localStorage.setItem(VOICE_STORAGE_KEY, id);
  }, []);

  // Keep a ref to the current voice so the speak callback always reads the
  // latest value without needing to be recreated when voiceId changes.
  const voiceIdRef = useRef(voiceId);
  voiceIdRef.current = voiceId;

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor || recognitionRef.current) return;

    const recognition = new Ctor();
    recognition.lang = "ru-RU";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal) continue;
        const transcript = result[0]?.transcript ?? "";
        if (!transcript) continue;
        console.log("[voice] heard:", transcript);
        handlersRef.current.onHear?.(transcript);
      }
    };

    recognition.onerror = (event) => {
      console.warn("[voice] recognition error:", event.error);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        listeningRef.current = false;
        setListening(false);
      }
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      if (listeningRef.current && !suppressRestartRef.current) start();
    };

    recognitionRef.current = recognition;
    listeningRef.current = true;
    recognition.start();
    setListening(true);
  }, []);

  const stop = useCallback(() => {
    listeningRef.current = false;
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (listeningRef.current) stop();
    else start();
  }, [start, stop]);

  // Edge TTS speak: fetch audio from /api/tts, play via <audio>.
  // Falls back to browser TTS if the server is unreachable.
  const speak = useCallback(
    (text: string) => {
      const seq = ++speakSeqRef.current;

      // Pause recognition so the assistant doesn't hear its own reply.
      const wasListening = listeningRef.current;
      if (wasListening) {
        suppressRestartRef.current = true;
        recognitionRef.current?.stop();
      }

      const resume = () => {
        if (speakSeqRef.current !== seq) return;
        setSpeaking(false);
        suppressRestartRef.current = false;
        if (wasListening && listeningRef.current) {
          setTimeout(() => {
            if (listeningRef.current) start();
          }, 400);
        }
      };

      // Try Edge TTS first.
      const voiceParam = voiceIdRef.current;
      fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: voiceParam }),
        signal: AbortSignal.timeout(15_000),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`TTS ${res.status}`);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.onended = () => {
            URL.revokeObjectURL(url);
            resume();
          };
          audio.onerror = () => {
            URL.revokeObjectURL(url);
            resume();
          };
          audio.onplay = () => {
            if (speakSeqRef.current === seq) setSpeaking(true);
          };
          await audio.play();
        })
        .catch(() => {
          // Fallback to browser TTS.
          console.warn("[voice] Edge TTS unavailable, falling back to browser TTS");
          speakBrowser(text, seq, speakSeqRef, setSpeaking, wasListening, listeningRef, suppressRestartRef, start);
        });
    },
    [start],
  );

  useEffect(() => {
    return () => {
      listeningRef.current = false;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  return { supported, listening, speaking, voiceId, setVoice, speak, start, stop, toggle };
}
