"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import { useVoiceAssistant } from "@/hooks/useVoiceAssistant";
import type { AssistantAction } from "@/lib/assistantBrain";

type CameraState = "off" | "starting" | "on" | "error";

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "ОЖИДАНИЕ",
  spin: "ВРАЩЕНИЕ",
  zoom: "МАСШТАБ",
};

const PROVIDER_LABEL: Record<string, string> = {
  webllm: "WEBLLM",
  ollama: "OLLAMA",
  openai: "OPENAI",
  groq: "GROQ",
  gemini: "GEMINI",
};

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [inputText, setInputText] = useState("");
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [hintsOpen, setHintsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "ДОСТУП К КАМЕРЕ ЗАПРЕЩЁН"
          : "ОШИБКА ИНИЦИАЛИЗАЦИИ",
      );
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  const launchApp = useCallback(async (appName: string, url?: string) => {
    const attempt = async (name: string, u?: string) => {
      try {
        const res = await fetch("/api/launch-app", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(u ? { name, url: u } : { name }),
        });
        return res;
      } catch (err) {
        console.warn("[voice] launch request failed:", err);
        return null;
      }
    };

    let res = await attempt(appName, url);
    if (res?.ok) {
      const data = await res.json().catch(() => null);
      const matched = typeof data?.matched === "string" ? data.matched : "";
      if (matched && matched !== appName) {
        assistantRef.current?.say(`Запускаю ${matched}.`);
      }
      return;
    }

    // Not found by name → let the LLM map the spoken (Russian) name onto the
    // installed list, then retry once. E.g. «майнкрафт» → "Minecraft".
    if (!url && res) {
      const resolved = await assistantRef.current?.resolveLaunch(appName);
      if (resolved) {
        res = await attempt(resolved);
        if (res?.ok) {
          const data = await res.json().catch(() => null);
          const matched = typeof data?.matched === "string" ? data.matched : "";
          assistantRef.current?.say(`Запускаю ${matched || resolved}.`);
          return;
        }
      }
    }

    assistantRef.current?.say(
      `Не удалось ${url ? "открыть" : "запустить"} «${appName}». Скажите «какие приложения есть» — покажу, что установлено.`,
    );
  }, []);

  const handleAssistantAction = useCallback(
    (action: AssistantAction) => {
      switch (action.kind) {
        case "zoom-in":
          sceneRef.current?.zoomIn();
          break;
        case "zoom-out":
          sceneRef.current?.zoomOut();
          break;
        case "reset":
          sceneRef.current?.resetView();
          break;
        case "gestures-on":
          void startGestures();
          break;
        case "gestures-off":
          stopGestures();
          break;
        case "stop":
          stopGestures();
          break;
        case "launch":
          void launchApp(action.app, action.url);
          break;
        case "start-lesson":
          void assistantRef.current?.startLesson(action.goal);
          break;
        case "stop-lesson":
          void assistantRef.current?.stopLesson();
          break;
        case "run-skill":
          void assistantRef.current?.runSkill(action.skillId);
          break;
      }
    },
    [startGestures, stopGestures, launchApp],
  );

  const assistant = useVoiceAssistant({ onAction: handleAssistantAction });
  const assistantRef = useRef(assistant);
  assistantRef.current = assistant;

  // The orb core pulses in sync with the voice: soft "attention" while
  // listening, a pronounced speech pulse while speaking.
  useEffect(() => {
    sceneRef.current?.setSpeaking(assistant.speaking || assistant.listening);
  }, [assistant.speaking, assistant.listening]);

  const toggleLesson = useCallback(() => {
    if (assistant.lesson) {
      void assistant.stopLesson();
      return;
    }
    const goal = window.prompt(
      "Что должен уметь УЛЬТРОН после урока? (покажите действие на экране)",
      "открыть блокнот и напечатать привет",
    );
    if (!goal?.trim()) return;
    void assistant.startLesson(goal.trim());
  }, [assistant]);

  const submitMessage = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const text = inputText.trim();
      if (!text) return;
      assistant.send(text);
      setInputText("");
      setMoreOpen(false);
    },
    [assistant, inputText],
  );

  // Keep the log scrolled to the newest message.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [assistant.messages, panelCollapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
        case "v":
        case "V":
          if (assistant.supported) assistant.toggle();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures, assistant]);

  const cameraOn = camera === "on";
  const assistantLive = assistant.listening || assistant.speaking;
  const statusLabel = assistant.speaking
    ? "ГОВОРИТ"
    : assistant.listening
      ? "СЛУШАЕТ"
      : PROVIDER_LABEL[assistant.activeProvider ?? assistant.preferredProvider ?? ""] ?? "В РЕЖИМЕ ОЖИДАНИЯ";

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="hud hud-title">U.L.T.R.O.N.</div>

      {mounted && (
        <div className="hud hud-hint-wrap">
          <button
            type="button"
            className="hint-toggle"
            aria-pressed={hintsOpen}
            onClick={() => setHintsOpen((o) => !o)}
            title="Подсказки"
          >
            ?
          </button>
          {hintsOpen && (
            <div className="hud-hint">
              <div>
                <span className="key">ТЯНИ</span> вращение&nbsp;&nbsp;
                <span className="key">КОЛЕСО</span> масштаб
              </div>
              {cameraOn ? (
                <div>
                  <span className="key">ЩИПОК + ДВИЖЕНИЕ</span> вращение&nbsp;&nbsp;
                  <span className="key">ДВА ЩИПКА ± РАЗВЕДЕНИЕ</span> масштаб
                </div>
              ) : (
                <div>
                  <span className="key">G</span> жесты&nbsp;&nbsp;
                  <span className="key">R</span> сброс&nbsp;&nbsp;
                  <span className="key">+/−</span> масштаб&nbsp;&nbsp;
                  <span className="key">V</span> голос
                </div>
              )}
              {assistant.supported && (
                <div>
                  <span className="key">ГОЛОС</span> «включи жесты» · «сброс» · «запусти …» ·
                  «выучи &lt;фраза&gt;» · «чему ты научился»
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {mounted && assistant.supported && (
        <div className="hud hud-assistant">
          <div className="assistant-head">
            <span className={`assistant-dot${assistantLive ? " live" : ""}`} />
            <span>J.A.R.V.I.S.</span>
            <span className="assistant-status">{statusLabel}</span>
            <span className="assistant-count">навыков: {assistant.learnedCount}</span>
            <button
              type="button"
              className="assistant-collapse"
              onClick={() => setPanelCollapsed((c) => !c)}
              aria-label={panelCollapsed ? "Развернуть панель" : "Свернуть панель"}
              title={panelCollapsed ? "Развернуть панель" : "Свернуть панель"}
            >
              {panelCollapsed ? "▸" : "▾"}
            </button>
          </div>

          {!panelCollapsed && (
            <>
              <div className="assistant-log" ref={logRef}>
                {assistant.messages.length === 0 && (
                  <div className="assistant-empty">
                    Голосовой помощник выключен. Нажми ГОВОРИТЬ или пиши сообщение.
                    Скажи «выучи &lt;фраза&gt;», чтобы обучить меня новой команде.
                  </div>
                )}
                {assistant.messages.map((m) => (
                  <div key={m.id} className={`assistant-msg ${m.role}`}>
                    {m.image ? (
                      <img
                        className="assistant-image"
                        src={`data:${m.image.mime};base64,${m.image.b64}`}
                        alt={m.text}
                        loading="lazy"
                      />
                    ) : (
                      m.text
                    )}
                  </div>
                ))}
              </div>

              {assistant.skills.length > 0 && (
                <div className="assistant-skills">
                  {assistant.skills.map((s) => (
                    <span key={s.id} className="skill-chip">
                      <button
                        type="button"
                        onClick={() => void assistant.runSkill(s.id)}
                        title={s.steps.map((st) => st.text ?? st.action).join(" → ")}
                      >
                        ▶ {s.name}
                      </button>
                      <button
                        type="button"
                        aria-label={`Забыть навык ${s.name}`}
                        onClick={() => assistant.forgetSkill(s.id)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="assistant-controls">
                <button
                  type="button"
                  className={`hud-btn hud-btn-mic${assistantLive ? " live" : ""}`}
                  aria-pressed={assistant.listening}
                  onClick={assistant.toggle}
                >
                  {assistant.listening ? "■ СТОП" : "● ГОВОРИТЬ"}
                </button>
                <button
                  type="button"
                  className="hud-btn"
                  aria-pressed={cameraOn}
                  onClick={toggleGestures}
                  disabled={camera === "starting"}
                >
                  {camera === "starting" ? "ЖЕСТЫ…" : cameraOn ? "✋ ЖЕСТЫ ВКЛ" : "✋ ЖЕСТЫ"}
                </button>
              </div>

              <form className="assistant-input" onSubmit={submitMessage}>
                <input
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="введи сообщение или команду…"
                  aria-label="Ввод сообщения"
                />
                <button type="submit" className="hud-btn">
                  ОК
                </button>
              </form>

              <div className="more-menu">
                <button
                  type="button"
                  className="hud-btn hud-btn-more"
                  aria-pressed={moreOpen}
                  onClick={() => setMoreOpen((o) => !o)}
                >
                  ⋯
                </button>
                {moreOpen && (
                  <div className="more-pop">
                    <button type="button" onClick={toggleLesson}>
                      {assistant.lesson ? `■ УРОК (${assistant.lesson.frames})` : "● ЗАПИСАТЬ УРОК"}
                    </button>
                    <button
                      type="button"
                      aria-pressed={assistant.teachMode}
                      onClick={assistant.toggleTeachMode}
                    >
                      ОБУЧЕНИЕ{assistant.teachMode ? " ВКЛ" : ""}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        assistant.say("Скажите «учись <что сделать>» — запишу урок, или «какие навыки» — покажу выученное.")
                      }
                    >
                      НАВЫКИ
                    </button>
                    <button type="button" onClick={assistant.cycleProvider}>
                      МОДЕЛЬ:{" "}
                      {PROVIDER_LABEL[assistant.activeProvider ?? assistant.preferredProvider ?? ""] ?? "АВТО"}
                    </button>
                    {!assistant.webllm.loaded && (
                      <button
                        type="button"
                        onClick={() => void assistant.loadWebLLM()}
                        disabled={assistant.webllm.loading}
                      >
                        {assistant.webllm.loading
                          ? `WEBLLM ${Math.round(assistant.webllm.progress * 100)}%`
                          : "WEBLLM"}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-pressed={assistant.pcControl}
                      onClick={assistant.togglePcControl}
                    >
                      ДОСТУП: {assistant.pcControl ? "ВКЛ" : "ВЫКЛ"}
                    </button>
                    <button type="button" onClick={assistant.clearLog}>
                      ОЧИСТИТЬ
                    </button>
                    <button type="button" onClick={assistant.forgetAll}>
                      ЗАБЫТЬ ВСЁ
                    </button>
                    <button type="button" onClick={() => sceneRef.current?.resetView()}>
                      СБРОС ВИДА
                    </button>
                  </div>
                )}
              </div>

              {assistant.webllm.error && <div className="hud-error">WEBLLM: {assistant.webllm.error}</div>}
            </>
          )}
        </div>
      )}

      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          {/* Mirrored preview so it behaves like a mirror */}
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `${status.hands} ${status.hands > 1 ? "РУКИ" : "РУКА"} · ${MODE_LABEL[status.mode]}`
              : "ПОКАЖИ РУКИ"}
          </div>
        </div>

        {error && <div className="hud-error">{error}</div>}
      </div>
    </>
  );
}
