import { z } from "zod";

export type AgentName = "lead" | "landing" | "proposal" | "support";

export type ContactAgentInput = {
  name: string;
  email: string;
  phone: string;
  message: string;
  conversationContext?: string;
};

type AgentRunResponse = {
  success: boolean;
  data?: {
    runId: string;
    parsedOutput: Record<string, unknown>;
    metadata: {
      durationMs: number;
      model: string;
      provider: string;
      attemptCount?: number;
      totalTokens?: number;
    };
  };
  error?: {
    code?: string;
    message?: string;
  };
};

type RunAgentOptions = {
  timeoutMs?: number;
  mode?: "fast" | "standard";
};

const responseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      runId: z.string(),
      parsedOutput: z.record(z.string(), z.unknown()),
      metadata: z.object({
        durationMs: z.number(),
        model: z.string(),
        provider: z.string(),
        attemptCount: z.number().optional(),
        totalTokens: z.number().optional()
      })
    })
    .optional(),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional()
    })
    .optional()
});

const boolFromEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) {
    return fallback;
  }
  return value.toLowerCase() === "true";
};

const timeoutFromEnv = (): number => {
  const raw = Number(process.env.AI_ENGINE_TIMEOUT_MS ?? 90000);
  if (!Number.isFinite(raw) || raw < 1000) {
    return 90000;
  }
  if (raw > 120000) {
    return 120000;
  }
  return Math.trunc(raw);
};

const normalizeTimeout = (value: number): number => {
  if (!Number.isFinite(value) || value < 1000) {
    return 1000;
  }
  if (value > 120000) {
    return 120000;
  }
  return Math.trunc(value);
};

const modeFromEnv = (): "fast" | "standard" => {
  const value = (process.env.AI_ENGINE_MODE ?? "standard").trim().toLowerCase();
  return value === "fast" ? "fast" : "standard";
};

const maxAgentsFromEnv = (): number => {
  const raw = Number(process.env.AI_ENGINE_MAX_AGENTS_PER_REQUEST ?? 2);
  if (!Number.isFinite(raw)) {
    return 2;
  }
  const n = Math.trunc(raw);
  if (n < 1) {
    return 1;
  }
  if (n > 4) {
    return 4;
  }
  return n;
};

const toLower = (value: string): string => value.toLowerCase();

const hits = (text: string, patterns: string[]): number =>
  patterns.reduce((acc, pattern) => (text.includes(pattern) ? acc + 1 : acc), 0);

const inferAgentsFromMessage = (message: string): AgentName[] => {
  const text = toLower(message);

  const supportHits = hits(text, [
    "soporte",
    "no puedo",
    "problema",
    "error",
    "bug",
    "incidencia",
    "ticket",
    "acceso",
    "dashboard bloqueado",
    "no funciona"
  ]);

  if (supportHits > 0) {
    return ["support"];
  }

  const landingHits = hits(text, ["landing", "landing page", "pagina", "captacion", "conversi", "sitio web", "ecommerce"]);
  const proposalHits = hits(text, [
    "propuesta",
    "cotiz",
    "presupuesto",
    "precio",
    "plan",
    "oferta",
    "integracion",
    "integración",
    "api",
    "apis",
    "vyaudit",
    "auditoria web",
    "auditoría web",
    "marketing digital",
    "app movil",
    "aplicacion movil",
    "aplicación móvil"
  ]);
  const leadHits = hits(text, ["lead", "leads", "cliente", "prospecto", "ventas", "reunion"]);

  const selected = new Set<AgentName>();
  if (proposalHits > 0) {
    selected.add("proposal");
  }
  if (landingHits > 0) {
    selected.add("landing");
  }
  if (leadHits > 0 || selected.size === 0) {
    selected.add("lead");
  }

  const ordered: AgentName[] = ["proposal", "landing", "lead"];
  return ordered.filter((agent) => selected.has(agent));
};

const extractRequestedServices = (message: string): string[] => {
  const text = toLower(message);
  const services: string[] = [];
  if (text.includes("landing")) {
    services.push("Landing de captacion");
  }
  if (text.includes("sitio web") || text.includes("pagina web") || text.includes("web")) {
    services.push("Sitio web corporativo o ecommerce");
  }
  if (text.includes("app movil") || text.includes("aplicacion movil") || text.includes("aplicación móvil")) {
    services.push("Desarrollo de app movil");
  }
  if (text.includes("integracion") || text.includes("integración") || text.includes("api") || text.includes("apis")) {
    services.push("Integraciones y APIs");
  }
  if (text.includes("vyaudit") || text.includes("auditoria web") || text.includes("auditoría web")) {
    services.push("VyAudit (auditoria web)");
  }
  if (text.includes("marketing digital") || text.includes("ads") || text.includes("campa") || text.includes("publicidad")) {
    services.push("Marketing digital");
  }
  if (text.includes("ads") || text.includes("campa") || text.includes("publicidad")) {
    services.push("Ads management");
  }
  if (text.includes("crm") || text.includes("automat")) {
    services.push("CRM automation");
  }
  if (services.length === 0) {
    services.push("Evaluacion comercial inicial");
  }
  return services;
};

const composeMessage = (input: ContactAgentInput): string => {
  const context = input.conversationContext?.trim();
  if (!context) {
    return input.message;
  }

  return `${input.message}\n\nContexto reciente:\n${context}\n\nInstruccion: responde breve y haz solo 1 pregunta clave.`;
};

const buildLeadInput = (input: ContactAgentInput) => ({
  leadMessage: composeMessage(input),
  companyContext: `Contacto web Vytronix. Nombre: ${input.name}. Email: ${input.email}. Telefono: ${input.phone}.`,
  knownServices: [
    "Landing pages",
    "Sitios web y ecommerce",
    "Apps moviles",
    "Integraciones y APIs",
    "VyAudit (auditoria web)",
    "Marketing digital",
    "Ads management",
    "CRM automation",
    "Web development"
  ]
});

const buildLandingInput = (input: ContactAgentInput) => ({
  projectName: `Landing para ${input.name}`,
  objective: composeMessage(input),
  audience: "Pendiente de discovery",
  offer: "Pendiente de discovery",
  constraints: ["No prometer resultados garantizados"],
  notes: `Lead web. Contacto: ${input.email} / ${input.phone}`
});

const buildProposalInput = (input: ContactAgentInput) => ({
  clientName: input.name,
  businessGoal: composeMessage(input),
  requestedServices: extractRequestedServices(input.message),
  timeline: "Pendiente de definir",
  budgetRange: "Pendiente de definir",
  constraints: ["Integrar con stack actual del cliente"]
});

const buildSupportInput = (input: ContactAgentInput) => ({
  ticketMessage: composeMessage(input),
  customerName: input.name,
  accountType: "Unknown",
  productArea: "General",
  knownContext: `Solicitud via formulario web. Email: ${input.email}. Telefono: ${input.phone}.`
});

const buildAgentInput = (agent: AgentName, input: ContactAgentInput): Record<string, unknown> => {
  switch (agent) {
    case "lead":
      return buildLeadInput(input);
    case "landing":
      return buildLandingInput(input);
    case "proposal":
      return buildProposalInput(input);
    case "support":
      return buildSupportInput(input);
    default:
      return buildLeadInput(input);
  }
};

export const isAiEngineEnabled = (): boolean => boolFromEnv(process.env.AI_ENGINE_ENABLED, false);

const getBaseUrl = (): string | null => {
  const value = process.env.AI_ENGINE_BASE_URL?.trim();
  if (!value) {
    return null;
  }
  return value.replace(/\/$/, "");
};

export const selectAgentsForContact = (input: ContactAgentInput): AgentName[] => {
  const inferred = inferAgentsFromMessage(input.message);
  const maxAgents = maxAgentsFromEnv();
  return inferred.slice(0, maxAgents);
};

export const runAgentForContact = async (
  agent: AgentName,
  input: ContactAgentInput,
  options?: RunAgentOptions
): Promise<AgentRunResponse> => {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    return {
      success: false,
      error: {
        code: "AI_ENGINE_BASE_URL_MISSING",
        message: "AI_ENGINE_BASE_URL is not configured"
      }
    };
  }

  const timeoutMs = normalizeTimeout(options?.timeoutMs ?? timeoutFromEnv());
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/api/agents/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.AI_ENGINE_API_KEY ? { "X-API-Key": process.env.AI_ENGINE_API_KEY } : {})
      },
      body: JSON.stringify({
        agent,
        mode: options?.mode ?? modeFromEnv(),
        input: buildAgentInput(agent, input)
      }),
      signal: controller.signal
    });

    const payload = (await response.json().catch(() => null)) as unknown;
    const parsed = responseSchema.safeParse(payload);

    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: "AI_ENGINE_RESPONSE_INVALID",
          message: "Invalid AI engine response"
        }
      };
    }

    if (!response.ok || !parsed.data.success) {
      return {
        success: false,
        error: {
          code: parsed.data.error?.code ?? "AI_ENGINE_REQUEST_FAILED",
          message: parsed.data.error?.message ?? `AI engine HTTP ${response.status}`
        }
      };
    }

    return parsed.data;
  } catch (error) {
    const isAbortError = error instanceof Error && error.name === "AbortError";
    return {
      success: false,
      error: {
        code: isAbortError ? "AI_ENGINE_TIMEOUT" : "AI_ENGINE_UNREACHABLE",
        message: error instanceof Error ? error.message : "Unknown AI engine error"
      }
    };
  } finally {
    clearTimeout(timeoutId);
  }
};
