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

export interface VoiceHandlers {
  /** Called for every final recognized phrase — the raw transcript. */
  onHear?(transcript: string): void;
}

export interface VoiceApi {
  supported: boolean;
  listening: boolean;
  speaking: boolean;
  /** Speak a line out loud via the built-in speechSynthesis (ru-RU). */
  speak(text: string): void;
  start(): void;
  stop(): void;
  toggle(): void;
}

/**
 * Raw speech I/O: continuous Russian recognition (Web Speech API) + TTS
 * synthesis. Recognition stubbornly stops itself after a pause in speech —
 * `onend` restarts it automatically as long as `listeningRef` says the user
 * still wants to be listening, which is what makes this feel "continuous".
 * It delivers raw transcripts via `onHear` and does no command parsing — the
 * AssistantBrain owns interpretation.
 */
export function useVoiceCommands(handlers: VoiceHandlers): VoiceApi {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const listeningRef = useRef(false);
  // While the assistant speaks (TTS), recognition is paused so it can't
  // hear its own voice and echo/re-execute the reply.
  const suppressRestartRef = useRef(false);
  const speakSeqRef = useRef(0);

  const [supported] = useState(() => getRecognitionCtor() !== null);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);

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
      // These mean the user (or OS) denied mic access — retrying would
      // just error again, so stop instead of looping forever.
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

  const speak = useCallback(
    (text: string) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      const seq = ++speakSeqRef.current;
      const synth = window.speechSynthesis;
      synth.cancel();

      // Pause recognition so the assistant doesn't hear its own reply.
      const wasListening = listeningRef.current;
      if (wasListening) {
        suppressRestartRef.current = true;
        recognitionRef.current?.stop();
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "ru-RU";
      // JARVIS-style delivery: calm, measured, deep — slightly slow, low pitch.
      utterance.rate = 0.9;
      utterance.pitch = 0.75;

      /** Prefer a deep Russian male voice (Pavel / male hints), else any ru voice. */
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
      // Voices may load asynchronously; retry once they arrive.
      if (synth.getVoices().length === 0) {
        synth.addEventListener("voiceschanged", applyVoice, { once: true });
      }

      // Resume listening only for the latest utterance (older ones may be
      // cancelled and fire their end events too).
      const resume = () => {
        if (speakSeqRef.current !== seq) return;
        setSpeaking(false);
        suppressRestartRef.current = false;
        if (wasListening && listeningRef.current) {
          // Small delay so the tail of our own speech isn't captured.
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

  return { supported, listening, speaking, speak, start, stop, toggle };
}
