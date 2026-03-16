"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";

type AgentChoice = "auto" | "lead" | "landing" | "proposal" | "support";

type ChatItem = {
  role: "user" | "assistant";
  text: string;
};

type ChatResponse = {
  success: boolean;
  sessionId?: string;
  agent?: Exclude<AgentChoice, "auto">;
  reply?: string;
  error?: string;
  missingInformation?: string[];
};

const SESSION_KEY = "vytronix_ai_chat_session_id";

export default function AiChatWidget() {
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentAgent, setCurrentAgent] = useState<Exclude<AgentChoice, "auto">>("lead");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const [messages, setMessages] = useState<ChatItem[]>([
    {
      role: "assistant",
      text: "Hola 👋 Soy el asistente de Vytronix. Escribe lo que necesitas y te guío paso a paso."
    }
  ]);

  const canSend = useMemo(() => input.trim().length >= 2 && !sending, [input, sending]);

  useEffect(() => {
    const persisted = window.sessionStorage.getItem(SESSION_KEY);
    if (persisted) {
      setSessionId(persisted);
    }
  }, []);

  useEffect(() => {
    if (sessionId) {
      window.sessionStorage.setItem(SESSION_KEY, sessionId);
    }
  }, [sessionId]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [messages, sending, open]);

  const sendMessage = async () => {
    if (!canSend) {
      return;
    }

    const message = input.trim();
    const nextHistory = [...messages, { role: "user" as const, text: message }];

    setInput("");
    setMessages(nextHistory);
    setSending(true);

    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionId ?? undefined,
          message,
          agent: "auto",
          history: nextHistory.slice(-10).map((item) => ({ role: item.role, text: item.text }))
        })
      });

      const payload = (await response.json().catch(() => null)) as ChatResponse | null;
      if (payload?.sessionId) {
        setSessionId(payload.sessionId);
      }

      if (!response.ok || !payload || !payload.success || !payload.reply) {
        const fallback = payload?.error ?? "No pude responder ahora. Intenta nuevamente en unos minutos.";
        setMessages((prev) => [...prev, { role: "assistant", text: fallback }]);
        return;
      }

      const tag = payload.agent ? `[${payload.agent}] ` : "";
      if (payload.agent) {
        setCurrentAgent(payload.agent);
      }
      setMessages((prev) => [...prev, { role: "assistant", text: `${tag}${payload.reply}` }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "No hay conexión con el asistente en este momento." }
      ]);
    } finally {
      setSending(false);
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await sendMessage();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="ai-chat-toggle-fixed rounded-full bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-lg hover:bg-blue-700"
        aria-label="Abrir asistente de Vytronix"
      >
        {open ? "Cerrar asistente" : "Asistente AI"}
      </button>

      {open ? (
        <section className="ai-chat-panel-fixed w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white shadow-2xl">
          <header className="border-b border-slate-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <Image
                src="/avatarasistente.png"
                alt="Avatar del asistente de Vytronix"
                width={56}
                height={56}
                className="h-14 w-14 rounded-full border border-slate-200 object-cover"
              />
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Asistente Vytronix</h3>
                <p className="text-xs text-slate-600">Respuestas guiadas por agentes especializados.</p>
              </div>
            </div>
          </header>

          <div ref={messagesContainerRef} className="space-y-2 px-3 py-3 max-h-72 overflow-y-auto bg-slate-50">
            {messages.map((message, idx) => (
              <div key={`${message.role}-${idx}`}>
                {message.role === "user" ? (
                  <div className="ml-8 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white">{message.text}</div>
                ) : (
                  <div className="mr-8 flex items-start gap-2">
                    <Image
                      src="/avatarasistente.png"
                      alt="Avatar del asistente"
                      width={40}
                      height={40}
                      className="mt-0.5 h-10 w-10 rounded-full border border-slate-200 object-cover"
                    />
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800">
                      {message.text}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {sending ? <div className="text-xs text-slate-500">Escribiendo...</div> : null}
          </div>

          <form onSubmit={onSubmit} className="border-t border-slate-200 p-3 space-y-2">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (canSend) {
                    void sendMessage();
                  }
                }
              }}
              placeholder="Escribe tu consulta..."
              className="min-h-[80px] w-full resize-y rounded-md border border-slate-300 px-2 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={!canSend}
              className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? "Enviando..." : "Enviar"}
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}
