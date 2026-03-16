import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAiEngineEnabled, runAgentForContact, type AgentName } from "@/server/ai/engine";
import { getOrCreateChatSession, resetLandingFlow, saveChatSession } from "@/server/ai/chat-session";
import { db } from "@/server/db/client";
import { aiAgentRuns, contactRequests } from "@/server/db/schema";
import { sendClientProposalEmail, sendContactNotificationEmail } from "@/server/email/mailer";

export const runtime = "nodejs";

const CHAT_TIMEOUT_MS = 45000;
const LANDING_PRICE_BASE_CLP = Number(process.env.AI_LANDING_BASE_PRICE_CLP ?? 200000);
const LANDING_PRICE_SETUP_CLP = Number(process.env.AI_LANDING_SETUP_PRICE_CLP ?? 120000);
const PROPOSAL_PRICE_MIN_CLP = Number(process.env.AI_PROPOSAL_MIN_PRICE_CLP ?? 300000);
const PROPOSAL_PRICE_MAX_CLP = Number(process.env.AI_PROPOSAL_MAX_PRICE_CLP ?? 1200000);
const MOBILE_APP_MIN_CLP = Number(process.env.AI_MOBILE_APP_MIN_CLP ?? 1500000);
const MOBILE_APP_MAX_CLP = Number(process.env.AI_MOBILE_APP_MAX_CLP ?? 8000000);
const WEBSITE_MIN_CLP = Number(process.env.AI_WEBSITE_MIN_CLP ?? 450000);
const WEBSITE_MAX_CLP = Number(process.env.AI_WEBSITE_MAX_CLP ?? 2500000);
const ECOMMERCE_MIN_CLP = Number(process.env.AI_ECOMMERCE_MIN_CLP ?? 900000);
const ECOMMERCE_MAX_CLP = Number(process.env.AI_ECOMMERCE_MAX_CLP ?? 4500000);
const INTEGRATION_API_MIN_CLP = Number(process.env.AI_INTEGRATION_API_MIN_CLP ?? 700000);
const INTEGRATION_API_MAX_CLP = Number(process.env.AI_INTEGRATION_API_MAX_CLP ?? 5000000);
const VYAUDIT_PRICE_CLP = Number(process.env.VYAUDIT_PRICE_CLP ?? 29990);
const MARKETING_BASIC_CLP = Number(process.env.AI_MARKETING_BASIC_CLP ?? 300000);
const MARKETING_MEDIUM_CLP = Number(process.env.AI_MARKETING_MEDIUM_CLP ?? 400000);
const MARKETING_ADVANCED_CLP = Number(process.env.AI_MARKETING_ADVANCED_CLP ?? 500000);
const MARKETING_DIAGNOSTIC_CLP = Number(process.env.AI_MARKETING_DIAGNOSTIC_CLP ?? 120000);

const schema = z.object({
  sessionId: z.string().uuid().optional(),
  message: z.string().min(1).max(1000),
  agent: z.enum(["auto", "lead", "landing", "proposal", "support"]).default("auto"),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().min(1).max(1000)
      })
    )
    .max(20)
    .optional()
});
type ChatHistoryItem = { role: "user" | "assistant"; text: string };

const clp = (value: number): string =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(value);

const normalize = (text: string): string => text.toLowerCase().trim();
const hasAny = (text: string, signals: string[]): boolean => signals.some((signal) => text.includes(signal));
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (text: string, word: string): boolean => new RegExp(`\\b${escapeRegex(word)}\\b`, "i").test(text);

const isGreeting = (message: string): boolean => {
  const text = normalize(message);
  return ["hola", "holi", "hello", "hi", "buenas", "buenos dias", "buenas tardes"].includes(text);
};

const isAffirmative = (message: string): boolean => {
  const text = normalize(message);
  const tokens = ["si", "dale", "ok", "perfecto", "avancemos", "listo"];
  const hasToken = tokens.some((token) => new RegExp(`\\b${token}\\b`, "i").test(text));
  return hasToken || text.includes("por favor") || text.includes("porfavor");
};

const isThanks = (message: string): boolean => {
  const text = normalize(message);
  return hasAny(text, ["gracias", "muchas gracias", "te pasaste", "genial gracias", "ok gracias"]);
};
const startsNewIntent = (message: string): boolean => {
  const text = normalize(message);
  return /^(necesito|quiero|mejor|ahora|pasemos|cambia|cambiar|hablemos)/i.test(text);
};

type ServiceIntent =
  | "mobile_apps"
  | "ecommerce"
  | "web_landing"
  | "integrations_api"
  | "vyaudit"
  | "marketing_digital"
  | "none";

type ServiceCatalogEntry = {
  title: string;
  offer: string;
  minPriceClp?: number;
  maxPriceClp?: number;
  fixedPriceClp?: number;
  priceNote: string;
  qualifierQuestion: string;
  cta: string;
};

const SERVICE_CATALOG: Record<Exclude<ServiceIntent, "none">, ServiceCatalogEntry> = {
  mobile_apps: {
    title: "Apps moviles",
    offer: "Desarrollo de apps iOS/Android (nativas o multiplataforma), listas para escalar.",
    minPriceClp: MOBILE_APP_MIN_CLP,
    maxPriceClp: MOBILE_APP_MAX_CLP,
    priceNote: "Rango referencial de mercado en Chile, sujeto a alcance funcional.",
    qualifierQuestion: "Que funcionalidades minimas necesitas para la primera version (MVP)?",
    cta: "Si quieres, te preparo un alcance base para cotizar hoy."
  },
  ecommerce: {
    title: "E-commerce con carrito",
    offer: "Tienda online con carrito de compras, checkout, gestion de productos/pedidos y medios de pago.",
    minPriceClp: ECOMMERCE_MIN_CLP,
    maxPriceClp: ECOMMERCE_MAX_CLP,
    priceNote: "Rango referencial de mercado en Chile, depende de catalogo, pagos e integraciones.",
    qualifierQuestion: "Cuantos productos tendra inicialmente y que medio de pago necesitas habilitar primero?",
    cta: "Si quieres, te preparo una propuesta ecommerce base con etapas y plazos."
  },
  web_landing: {
    title: "Sitios web y landing pages",
    offer:
      "Landing pages y sitios web rapidos (e-commerce y corporativos), accesibles y orientados a convertir, con diseno responsivo, alto rendimiento y arquitectura moderna lista para crecer.",
    minPriceClp: WEBSITE_MIN_CLP,
    maxPriceClp: WEBSITE_MAX_CLP,
    priceNote: `Landing desde ${clp(LANDING_PRICE_BASE_CLP)} + IVA. Setup estrategico opcional ${clp(LANDING_PRICE_SETUP_CLP)} + IVA.`,
    qualifierQuestion: "Tu prioridad principal es ventas, captacion de leads o reuniones?",
    cta: "Si quieres, te guio en 5 pasos para cerrar brief ahora."
  },
  integrations_api: {
    title: "Integraciones y APIs",
    offer: "Integraciones con CRM, ERP, pasarelas de pago y terceros, incluyendo APIs y sincronizacion de datos.",
    minPriceClp: INTEGRATION_API_MIN_CLP,
    maxPriceClp: INTEGRATION_API_MAX_CLP,
    priceNote: "Rango referencial de mercado en Chile, segun cantidad de sistemas y reglas de sincronizacion.",
    qualifierQuestion: "Que sistemas necesitas integrar primero y si debe ser en tiempo real?",
    cta: "Si quieres, te armo una propuesta tecnica inicial."
  },
  vyaudit: {
    title: "VyAudit (auditoria de sitios web)",
    offer: "Auditoria de paginas/sitios web con informe tecnico-comercial: performance, SEO, UX, accesibilidad y seguridad.",
    fixedPriceClp: VYAUDIT_PRICE_CLP,
    priceNote: "Pago unico por dominio.",
    qualifierQuestion: "Cual es el dominio que quieres auditar?",
    cta: "Si quieres, te comparto los pasos para solicitar VyAudit ahora."
  },
  marketing_digital: {
    title: "Marketing digital",
    offer: "Planes mensuales para trafico, leads y ventas, con estrategia, contenido y Ads.",
    priceNote: `Planes mensuales: Basico ${clp(MARKETING_BASIC_CLP)} + IVA, Medio ${clp(MARKETING_MEDIUM_CLP)} + IVA, Avanzado ${clp(MARKETING_ADVANCED_CLP)} + IVA. Diagnostico inicial ${clp(MARKETING_DIAGNOSTIC_CLP)} + IVA.`,
    qualifierQuestion: "Que objetivo quieres priorizar: leads, ventas o posicionamiento?",
    cta: "Si quieres, te recomiendo el plan ideal segun tu objetivo y presupuesto."
  }
};

const detectServiceIntent = (message: string): ServiceIntent => {
  const text = normalize(message);

  if (hasAny(text, ["vyaudit", "auditoria web", "auditoría web", "seo tecnico", "informe pdf"])) {
    return "vyaudit";
  }
  if (hasAny(text, ["ecommerce", "e-commerce", "tienda online", "carrito", "carro de compras", "checkout"])) {
    return "ecommerce";
  }
  if (
    hasAny(text, ["integracion", "integración", "crm", "webhook", "erp", "pasarela de pago"]) ||
    hasWord(text, "api") ||
    hasWord(text, "apis")
  ) {
    return "integrations_api";
  }
  if (hasAny(text, ["marketing digital", "ads", "campanas", "campañas", "meta ads", "google ads", "contenido"])) {
    return "marketing_digital";
  }
  if (hasAny(text, ["app movil", "aplicacion movil", "aplicación móvil"]) || hasWord(text, "android")) {
    return "mobile_apps";
  }
  if (hasAny(text, ["landing", "landing page", "pagina web", "sitio web", "ecommerce", "tienda online", "web", "ofrecer servicios", "ofrecer mis servicios", "sitio corporativo", "pagina corporativa"])) {
    return "web_landing";
  }

  return "none";
};

const detectComplexity = (message: string): "baja" | "media" | "alta" => {
  const text = normalize(message);
  const highSignals = [
    "erp",
    "sap",
    "marketplace",
    "multitienda",
    "multi sucursal",
    "integracion en tiempo real",
    "inventario",
    "suscripcion",
    "app movil",
    "api publica",
    "api pública"
  ];
  const mediumSignals = ["checkout", "webpay", "mercado pago", "crm", "dashboard", "automatizacion", "automatización"];

  if (hasAny(text, highSignals)) return "alta";
  if (hasAny(text, mediumSignals)) return "media";
  return "baja";
};

const parseBudgetClpFromText = (text: string): number | null => {
  const normalized = normalize(text);

  const compact = normalized.match(/(?:\$\s*)?(\d{1,3}(?:[.\s]\d{3})+)/);
  if (compact?.[1]) {
    const digits = compact[1].replace(/[.\s]/g, "");
    const value = Number(digits);
    if (Number.isFinite(value) && value >= 100000) {
      return value;
    }
  }

  const long = normalized.match(/\b([1-9]\d{5,})\b/);
  if (long?.[1]) {
    const value = Number(long[1]);
    if (Number.isFinite(value)) {
      return value;
    }
  }

  return null;
};

const detectUrgencyMultiplier = (text: string): number => {
  const normalized = normalize(text);

  if (hasAny(normalized, ["urgente", "asap", "hoy", "24h", "24 h", "mañana", "manana"])) {
    return 1.35;
  }
  if (/\b(1|un|una)\s+dia\b/.test(normalized) || /\b(2|3)\s+dias\b/.test(normalized)) {
    return 1.25;
  }
  if (/\b(1|una?)\s+semana\b/.test(normalized)) {
    return 1.18;
  }
  if (/\b2\s+semanas\b/.test(normalized)) {
    return 1.1;
  }

  return 1;
};

const estimateServicePrice = (entry: ServiceCatalogEntry, message: string, history?: ChatHistoryItem[]): string => {
  if (typeof entry.fixedPriceClp === "number") {
    return `Valor referencial: ${clp(entry.fixedPriceClp)} + IVA.`;
  }

  if (typeof entry.minPriceClp !== "number" || typeof entry.maxPriceClp !== "number") {
    return entry.priceNote;
  }

  const contextText = [
    ...(history ?? []).filter((item) => item.role === "user").map((item) => item.text),
    message
  ].join("\n");

  const complexity = detectComplexity(contextText);
  const urgencyMultiplier = detectUrgencyMultiplier(contextText);
  const budget = parseBudgetClpFromText(contextText);

  const min = entry.minPriceClp;
  const max = entry.maxPriceClp;
  const span = max - min;

  let baseMin = min;
  let baseMax = min + span * 0.35;

  if (complexity === "media") {
    baseMin = min + span * 0.3;
    baseMax = min + span * 0.7;
  }

  if (complexity === "alta") {
    baseMin = min + span * 0.65;
    baseMax = max;
  }

  // Recargo por prioridad: a menor plazo, mayor costo.
  const cappedMax = Math.round(max * 1.25);
  let adjustedMin = Math.round(baseMin * urgencyMultiplier);
  let adjustedMax = Math.round(baseMax * urgencyMultiplier);

  adjustedMin = Math.max(min, Math.min(adjustedMin, cappedMax));
  adjustedMax = Math.max(adjustedMin, Math.min(adjustedMax, cappedMax));

  if (budget && budget >= min && budget <= cappedMax) {
    const spread = Math.max(Math.round(budget * 0.15), 120000);
    adjustedMin = Math.max(min, budget - spread);
    adjustedMax = Math.min(cappedMax, budget + spread);
    if (adjustedMin > adjustedMax) {
      adjustedMin = Math.max(min, adjustedMax - 120000);
    }
  }

  const urgencyTag = urgencyMultiplier > 1 ? ", prioridad alta por plazo" : "";
  const budgetTag = budget ? ` Presupuesto detectado: ${clp(budget)}.` : "";

  return `Estimacion referencial personalizada (complejidad ${complexity}${urgencyTag}): ${clp(adjustedMin)} a ${clp(adjustedMax)} + IVA.${budgetTag}`;
};

const estimateServiceTotalClp = (entry: ServiceCatalogEntry, message: string, history?: ChatHistoryItem[]): number | null => {
  if (typeof entry.fixedPriceClp === "number") {
    return entry.fixedPriceClp;
  }

  if (typeof entry.minPriceClp !== "number" || typeof entry.maxPriceClp !== "number") {
    return null;
  }

  const contextText = [
    ...(history ?? []).filter((item) => item.role === "user").map((item) => item.text),
    message
  ].join("\n");

  const complexity = detectComplexity(contextText);
  const urgencyMultiplier = detectUrgencyMultiplier(contextText);
  const budget = parseBudgetClpFromText(contextText);

  const min = entry.minPriceClp;
  const max = entry.maxPriceClp;
  const span = max - min;

  let baseMin = min;
  let baseMax = min + span * 0.35;

  if (complexity === "media") {
    baseMin = min + span * 0.3;
    baseMax = min + span * 0.7;
  }

  if (complexity === "alta") {
    baseMin = min + span * 0.65;
    baseMax = max;
  }

  const cappedMax = Math.round(max * 1.25);
  let adjustedMin = Math.round(baseMin * urgencyMultiplier);
  let adjustedMax = Math.round(baseMax * urgencyMultiplier);

  adjustedMin = Math.max(min, Math.min(adjustedMin, cappedMax));
  adjustedMax = Math.max(adjustedMin, Math.min(adjustedMax, cappedMax));

  if (budget && budget >= min && budget <= cappedMax) {
    return budget;
  }

  return Math.round((adjustedMin + adjustedMax) / 2);
};
const formatCatalogReply = (entry: ServiceCatalogEntry, message: string, history?: ChatHistoryItem[]): string =>
  `${entry.title}: ${entry.offer}\n${estimateServicePrice(entry, message, history)}\n${entry.priceNote}\nPregunta clave: ${entry.qualifierQuestion}\n${entry.cta}`;

const inferServiceIntentFromContext = (message: string, history?: ChatHistoryItem[]): ServiceIntent => {
  const direct = detectServiceIntent(message);
  if (direct !== "none") {
    return direct;
  }

  if (!history || history.length === 0) {
    return "none";
  }

  const userText = history
    .filter((item) => item.role === "user")
    .map((item) => item.text)
    .join("\n");
  return detectServiceIntent(userText);
};

type CommercialData = {
  objective?: boolean;
  timeline?: boolean;
  budget?: boolean;
  products?: boolean;
  paymentMethod?: boolean;
  systems?: boolean;
};

const extractCommercialData = (message: string, history?: ChatHistoryItem[]): CommercialData => {
  const source = [...(history ?? []).filter((h) => h.role === "user").map((h) => h.text), message].join("\n");
  const text = normalize(source);
  // Budget by amount only when it looks like money (e.g. 500.000 or 150000), not tiny numbers like "1 semana".
  const hasBudgetAmountPattern =
    /(?:\$\s*)?\d{1,3}(?:[.\s]\d{3})+(?:,\d+)?/.test(text) ||
    /\b[1-9]\d{5,}\b/.test(text);

  return {
    objective: hasAny(text, [
      "objetivo",
      "ventas",
      "leads",
      "reuniones",
      "presentacion",
      "presentación",
      "aumentar ventas",
      "captar leads",
      "conversion",
      "conversión",
      "vender",
      "ofrecer mis servicios",
      "ofrecer servicios",
      "mostrar servicios",
      "venta online",
      "ventas online",
      "vender online",
      "ecommerce",
      "e-commerce"
    ]),
    timeline: hasAny(text, ["semana", "semanas", "mes", "meses", "dias", "días", "plazo", "fecha"]),
    budget: hasAny(text, ["presupuesto", "$", "clp", "millon", "millón", "mil", "pesos"]) || hasBudgetAmountPattern,
    products: hasAny(text, ["producto", "productos", "sku", "catalogo", "catálogo"]),
    paymentMethod: hasAny(text, ["mercado pago", "webpay", "transferencia", "tarjeta", "medio de pago", "pago"]),
    systems: hasAny(text, ["crm", "erp", "api", "integracion", "integración", "webhook", "sistema"])
  };
};

const inferServiceLabel = (intent: ServiceIntent): string => {
  switch (intent) {
    case "web_landing":
      return "Sitio web / landing";
    case "ecommerce":
      return "E-commerce con carrito";
    case "integrations_api":
      return "Integraciones & APIs";
    case "mobile_apps":
      return "App movil";
    case "marketing_digital":
      return "Marketing digital";
    case "vyaudit":
      return "VyAudit (auditoria web)";
    default:
      return "Servicio no definido";
  }
};

const alreadyCapturedInHistory = (history?: ChatHistoryItem[]): boolean => {
  if (!history || history.length === 0) {
    return false;
  }
  return history.some(
    (item) =>
      item.role === "assistant" &&
      item.text.toLowerCase().includes("datos recibidos") &&
      item.text.toLowerCase().includes("propuesta formal")
  );
};

const buildProposalNextSteps = (serviceIntent: ServiceIntent): string[] => {
  switch (serviceIntent) {
    case "ecommerce":
      return [
        "Validar alcance de catalogo, pagos y flujo de compra",
        "Aprobar propuesta tecnico-comercial",
        "Iniciar kickoff y cronograma de implementacion"
      ];
    case "integrations_api":
      return [
        "Definir sistemas origen/destino y campos de datos",
        "Aprobar alcance tecnico por fases",
        "Iniciar implementacion y pruebas de integracion"
      ];
    case "mobile_apps":
      return [
        "Confirmar funcionalidades MVP",
        "Aprobar propuesta por fases (UX/UI, desarrollo, QA)",
        "Iniciar kickoff y plan de entrega"
      ];
    case "marketing_digital":
      return [
        "Definir objetivo y KPI principal",
        "Aprobar plan recomendado y presupuesto mensual",
        "Iniciar ejecucion y calendario de contenidos/campanas"
      ];
    case "vyaudit":
      return [
        "Confirmar dominio a auditar",
        "Ejecutar auditoria web",
        "Recibir informe con plan de mejora priorizado"
      ];
    case "web_landing":
    default:
      return [
        "Validar objetivos y estructura del sitio",
        "Aprobar propuesta tecnico-comercial",
        "Iniciar kickoff y desarrollo"
      ];
  }
};

const resolveServiceIntentForHandoff = (intent: ServiceIntent, history?: ChatHistoryItem[]): Exclude<ServiceIntent, "none"> => {
  if (intent !== "none") {
    return intent;
  }

  const userText = (history ?? [])
    .filter((h) => h.role === "user")
    .map((h) => h.text)
    .join("\n");

  const inferred = detectServiceIntent(userText);
  if (inferred !== "none") {
    return inferred;
  }

  const normalized = normalize(userText);
  if (hasAny(normalized, ["servicio", "servicios", "empresa", "negocio", "sitio", "pagina", "web", "corporativo"])) {
    return "web_landing";
  }

  return "web_landing";
};

const findTimelineSnippet = (history?: ChatHistoryItem[]): string | null => {
  const userLines = (history ?? [])
    .filter((h) => h.role === "user")
    .map((h) => h.text.trim())
    .filter(Boolean);

  for (let i = userLines.length - 1; i >= 0; i -= 1) {
    const line = userLines[i];
    const lower = normalize(line);
    if (hasAny(lower, ["semana", "semanas", "mes", "meses", "dia", "dias", "plazo"])) {
      return line;
    }
  }

  return null;
};

const persistProposalHandoff = async (params: {
  email: string;
  phone: string;
  serviceIntent: ServiceIntent;
  history?: ChatHistoryItem[];
}): Promise<void> => {
  const id = crypto.randomUUID();
  const resolvedIntent = resolveServiceIntentForHandoff(params.serviceIntent, params.history);
  const serviceLabel = inferServiceLabel(resolvedIntent);

  const userTurns = (params.history ?? [])
    .filter((h) => h.role === "user")
    .slice(-6)
    .map((h) => `- ${h.text}`)
    .join("\n");

  const joinedUserText = (params.history ?? [])
    .filter((h) => h.role === "user")
    .map((h) => h.text)
    .join("\n");

  const budgetDetected = parseBudgetClpFromText(joinedUserText);
  const timelineDetected = findTimelineSnippet(params.history);

  const message = [
    "Lead capturado por Asistente AI (chat widget)",
    "",
    "Datos clave:",
    `- Servicio detectado: ${serviceLabel}`,
    `- Email: ${params.email}`,
    `- WhatsApp: ${params.phone}`,
    budgetDetected ? `- Presupuesto detectado: ${clp(budgetDetected)}` : "- Presupuesto detectado: no informado",
    timelineDetected ? `- Plazo detectado: ${timelineDetected}` : "- Plazo detectado: no informado",
    "",
    "Ultimos mensajes del cliente:",
    userTurns || "- (sin contexto reciente)"
  ].join("\n");

  await db.insert(contactRequests).values({
    id,
    name: "Lead Chat Widget",
    email: params.email,
    phone: params.phone,
    message,
    acceptedPolicies: true,
    status: "nuevo"
  });

  await db.insert(aiAgentRuns).values({
    id: crypto.randomUUID(),
    contactRequestId: id,
    agent: "proposal",
    status: "success",
    provider: "internal",
    model: "chat-widget-handoff",
    parsedOutput: {
      source: "chat_widget",
      serviceIntent: resolvedIntent,
      handoffCreated: true
    }
  });

  const mailResult = await sendContactNotificationEmail({
    name: "Lead Chat Widget",
    email: params.email,
    phone: params.phone,
    message
  });

  if (!mailResult.ok) {
    console.error("[MAIL] Handoff notification error", mailResult.error);
  }

  const catalog = SERVICE_CATALOG[resolvedIntent];
  const estimatedPrice = estimateServicePrice(catalog, joinedUserText || message, params.history);
  const totalClp = estimateServiceTotalClp(catalog, joinedUserText || message, params.history);
  const totalEstimate = totalClp ? `${clp(totalClp)} + IVA` : undefined;
  const clientSummary = [
    `Servicio recomendado: ${serviceLabel}.`,
    timelineDetected ? `Plazo detectado: ${timelineDetected}.` : "Plazo: por confirmar.",
    budgetDetected ? `Presupuesto detectado: ${clp(budgetDetected)}.` : "Presupuesto: por confirmar.",
    "Esta propuesta es referencial y se ajusta al alcance final."
  ].join("\n");

  const clientMail = await sendClientProposalEmail({
    toEmail: params.email,
    service: serviceLabel,
    estimatedPrice,
    totalEstimate,
    summary: clientSummary,
    nextSteps: buildProposalNextSteps(resolvedIntent)
  });

  if (!clientMail.ok) {
    console.error("[MAIL] Client proposal email error", clientMail.error);
  }
};
const serviceFollowUpReply = (
  serviceIntent: Exclude<ServiceIntent, "none">,
  message: string,
  history?: ChatHistoryItem[]
): string | null => {
  const data = extractCommercialData(message, history);
  const intro = formatCatalogReply(SERVICE_CATALOG[serviceIntent], message, history);
  const fullText = normalize([...(history ?? []).map((h) => h.text), message].join("\n"));

  if (serviceIntent === "web_landing") {
    if (!data.objective) return `${intro}\n\nPara partir bien: cual es el objetivo principal del sitio (presentacion, leads o ventas)?`;
    if (!data.timeline) return "Perfecto. En que plazo quieres lanzar el sitio web?";
    if (!data.budget) return "Excelente. Para ajustar propuesta: cual es tu presupuesto estimado?";
    if (hasAny(normalize(message), ["gracias", "muchas gracias"])) {
      return "Con gusto. Si quieres, te envio el resumen de propuesta web y siguientes pasos para iniciar.";
    }
    if (isAffirmative(message)) {
      return "Perfecto. Para enviarte la propuesta formal hoy, comparteme correo y WhatsApp de contacto.";
    }
    return "Buenisimo. Con objetivo, plazo y presupuesto te preparo una propuesta web inicial con estructura, etapas y fecha estimada de entrega. Quieres que la dejemos lista hoy?";
  }

  if (serviceIntent === "ecommerce") {
    if (!data.products) return `${intro}\n\nPara afinar la propuesta: cuantos productos tendras al inicio?`;
    if (!data.paymentMethod) return "Perfecto. Para ecommerce, que medio de pago necesitas habilitar primero (Mercado Pago, Webpay o transferencia)?";
    if (!data.objective) return "Buen avance. Ahora dime el objetivo comercial principal (ej: aumentar ventas o ticket promedio).";
    if (!data.timeline) return "Genial. En que plazo quieres lanzar la tienda online?";
    if (!data.budget) return "Ultimo dato para cerrar una propuesta precisa: cual es tu presupuesto estimado?";
    return "Excelente. Ya tengo objetivo, plazo, presupuesto, productos y pagos. Te preparo propuesta ecommerce inicial con etapas y estimacion para validar.";
  }

  if (serviceIntent === "integrations_api") {
    if (!data.systems) return `${intro}\n\nPara avanzar: que sistemas necesitas conectar primero (CRM, ERP, e-commerce, pagos u otros)?`;
    if (!data.objective) return "Perfecto. Cual es el resultado que buscas con la integracion (ahorro operativo, menos errores o mayor velocidad)?";
    if (!data.timeline) return "En que plazo necesitas tener la primera integracion operativa?";
    if (!data.budget) return "Para ajustar alcance tecnico: cual es tu presupuesto estimado?";
    return "Excelente. Con esto te preparo una propuesta tecnica por fases (discovery, integracion, pruebas y despliegue).";
  }

  if (serviceIntent === "mobile_apps") {
    if (!data.objective) return `${intro}\n\nPara partir bien: que problema principal resolvera tu app movil?`;
    if (!data.timeline) return "En que plazo quieres lanzar la primera version (MVP)?";
    if (!data.budget) return "Para recomendar arquitectura y alcance: cual es tu presupuesto estimado?";
    return "Perfecto. Con esos datos te armamos propuesta de app movil por etapas (UX/UI, desarrollo, QA y publicacion).";
  }

  if (serviceIntent === "marketing_digital") {
    if (!data.objective) return `${intro}\n\nPara recomendar plan exacto: priorizas leads, ventas o posicionamiento?`;
    if (!data.timeline) return "En que horizonte quieres medir resultados iniciales (30, 60 o 90 dias)?";
    if (!data.budget) return "Cual es tu presupuesto mensual estimado para marketing (gestion + pauta)?";
    return "Excelente. Con eso te propongo plan recomendado (Basico/Medio/Avanzado), KPIs y roadmap de ejecucion.";
  }

  if (serviceIntent === "vyaudit") {
    if (!hasAny(fullText, [".cl", ".com", ".net", ".org", "www", "http"])) {
      return `${intro}\n\nComparte el dominio exacto que quieres auditar (ej: midominio.cl).`;
    }
    return "Perfecto. Con ese dominio te guiamos para solicitar VyAudit y recibir tu informe accionable.";
  }

  return null;
};

const detectExplicitAgent = (message: string): AgentName | undefined => {
  const text = normalize(message);

  if (hasAny(text, ["error", "soporte", "ticket", "incidencia", "no puedo", "falla", "bug", "acceso"])) {
    return "support";
  }

  if (
    hasAny(text, [
      "propuesta",
      "cotiz",
      "presupuesto",
      "precio",
      "plan",
      "oferta",
      "ecommerce",
      "e-commerce",
      "carrito",
      "checkout",
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
    ])
  ) {
    return "proposal";
  }

  if (
    hasAny(text, [
      "landing",
      "landing page",
      "pagina web",
      "sitio web",
      "web",
      "captacion",
      "embudo",
      "cta"
    ])
  ) {
    return "landing";
  }

  if (hasAny(text, ["ejecutivo", "asesor", "comercial", "lead", "leads", "clientes", "ventas", "prospectos"])) {
    return "lead";
  }

  return undefined;
};

const chooseAgent = (message: string, requested: "auto" | AgentName, current: AgentName): AgentName => {
  if (requested !== "auto") {
    return requested;
  }

  const explicit = detectExplicitAgent(message);

  if (!explicit) {
    return current;
  }

  if (explicit === current) {
    return current;
  }

  if (current === "lead") {
    return explicit;
  }

  if (startsNewIntent(message)) {
    return explicit;
  }

  return current;
};

const buildConversationContext = (
  history: Array<{ role: "user" | "assistant"; text: string }> | undefined
): string | undefined => {
  if (!history || history.length === 0) {
    return undefined;
  }

  return history
    .slice(-6)
    .map((item) => `${item.role === "user" ? "Cliente" : "Asistente"}: ${item.text}`)
    .join("\n");
};

const formatAgentReply = (agent: AgentName, parsedOutput: Record<string, unknown>): string => {
  const readString = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = parsedOutput[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  };

  switch (agent) {
    case "lead":
      return readString("safe_reply", "reply_to_client", "suggested_next_action", "summary") ??
        "Gracias por tu mensaje. Te ayudo a definir el siguiente paso comercial.";
    case "proposal":
      return readString("executive_summary", "proposal_title") ??
        "Puedo ayudarte a estructurar una propuesta comercial clara.";
    case "support":
      return readString("suggested_reply", "summary") ??
        "Recibimos tu caso. Te ayudamos a resolverlo paso a paso.";
    case "landing":
    default:
      return readString("brief_markdown", "project_summary") ??
        "Te ayudo a definir el brief de tu landing.";
  }
};

const extractEmail = (message: string): string | undefined => {
  const match = message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0];
};

const extractPhone = (message: string): string | undefined => {
  const match = message.match(/(\+?\d[\d\s().-]{7,}\d)/);
  return match?.[0]?.trim();
};

const maybeAfterColon = (message: string): string => {
  const idx = message.indexOf(":");
  if (idx === -1) {
    return message.trim();
  }
  return message.slice(idx + 1).trim() || message.trim();
};

const updateLandingStateFromMessage = (message: string, state: ReturnType<typeof getOrCreateChatSession>["landing"]): void => {
  const text = normalize(message);

  if (hasAny(text, ["vender", "ventas", "captar", "leads", "reuniones", "conversion"])) {
    state.goal = state.goal ?? message.trim();
  }

  if (hasAny(text, ["publico", "audiencia", "persona", "personas", "segmento", "nicho", "deportista", "deportistas", "b2b", "b2c"])) {
    state.audience = message.trim();
  }

  if (hasAny(text, ["producto", "productos", "servicio", "demo", "diagnostico", "oferta"])) {
    state.offer = state.offer ?? message.trim();
  }

  if (hasAny(text, ["semana", "semanas", "mes", "meses", "plazo", "fecha", "dias", "dia"])) {
    state.timeline = message.trim();
  }

  if (hasAny(text, ["conversion", "conversiones", "conversión"])) {
    state.focus = "conversion";
  } else if (hasAny(text, ["lead", "leads", "calificacion", "calificación"])) {
    state.focus = "lead_qualification";
  }

  if (hasAny(text, ["marca", "nombre de marca", "branding"])) {
    state.brand = maybeAfterColon(message);
  }

  if (hasAny(text, ["referencia", "visual", "estilo", "tendencia", "inspiracion", "inspiración"])) {
    state.visualReference = maybeAfterColon(message);
  }

  if (hasAny(text, ["transferencia", "tarjeta", "webpay", "mercado pago", "pago", "medio de pago"])) {
    state.paymentMethod = maybeAfterColon(message);
  }

  const email = extractEmail(message);
  if (email) {
    state.contactEmail = email;
  }

  const phone = extractPhone(message);
  if (phone) {
    state.contactPhone = phone;
  }
};

const landingFlowReply = (message: string, session: ReturnType<typeof getOrCreateChatSession>): string => {
  const state = session.landing;
  updateLandingStateFromMessage(message, state);

  if (state.completed) {
    if (isAffirmative(message)) {
      return "Perfecto, quedo todo confirmado. En breve te contactamos para iniciar kickoff y mockup.";
    }
    return "Ya tengo todos tus datos y el inicio quedo confirmado. Si quieres, te comparto el resumen final del brief.";
  }

  if (state.kickoffRequested && (state.contactEmail || state.contactPhone)) {
    state.completed = true;
    return "Perfecto, datos recibidos. Ya dejamos agendado el kickoff. Te enviaremos confirmacion por correo o WhatsApp y empezamos con mockup y estructura final.";
  }

  if (state.briefClosed && isAffirmative(message)) {
    state.kickoffRequested = true;
    return "Excelente, iniciamos hoy. Comparte correo y WhatsApp de contacto para enviarte el kickoff ahora mismo.";
  }

  if (!state.goal) {
    return "Perfecto. Para tu landing, cual es el objetivo principal (ventas, leads o reuniones)?";
  }

  if (!state.audience) {
    return "Buen objetivo. A que publico exacto quieres dirigir esta landing?";
  }

  if (!state.offer) {
    return "Que oferta vas a presentar en la landing (producto/servicio, demo o diagnostico)?";
  }

  if (!state.timeline) {
    return "En que plazo quieres publicar la landing?";
  }

  if (!state.focus) {
    return "Excelente. Quieres enfocarla en conversion o en calificacion de leads?";
  }

  if (!state.quoteSent) {
    state.quoteSent = true;
    return `Perfecto. Ya tengo objetivo, publico, oferta y plazo.\n\nEstimacion referencial:\n- Landing page: desde ${clp(LANDING_PRICE_BASE_CLP)} + IVA\n- Setup estrategico (opcional): ${clp(LANDING_PRICE_SETUP_CLP)} + IVA\n\nSi quieres, te preparo el brief + propuesta en el siguiente mensaje.`;
  }

  if (state.quoteSent && !state.briefSent) {
    if (isAffirmative(message)) {
      state.briefSent = true;
      return `Perfecto. Brief inicial sugerido:\n1) Hero con propuesta de valor clara\n2) Seccion de productos/beneficios\n3) Prueba social\n4) CTA principal: Comprar ahora\n5) CTA secundario: Ver catalogo\n\nPropuesta inicial:\n- Diseno + desarrollo landing: desde ${clp(LANDING_PRICE_BASE_CLP)} + IVA\n- Setup estrategico opcional: ${clp(LANDING_PRICE_SETUP_CLP)} + IVA\n- Plazo estimado: ${state.timeline}\n\nPara cerrar brief, comparteme: nombre de marca, referencia visual y medio de pago.`;
    }

    return "Si te hace sentido, te preparo ahora el brief + propuesta inicial.";
  }

  if (!state.briefClosed) {
    const missing: string[] = [];
    if (!state.brand) missing.push("nombre de marca");
    if (!state.visualReference) missing.push("referencia visual");
    if (!state.paymentMethod) missing.push("medio de pago");

    if (missing.length > 0) {
      return `Perfecto, ya avance con parte del cierre. Solo me falta: ${missing.join(", ")}.`;
    }

    state.briefClosed = true;
    return "Excelente, brief cerrado. Resumen confirmado: marca, referencia visual, medio de pago y enfoque. Quieres que lo dejemos listo para iniciar hoy?";
  }

  return "Quieres que lo dejemos listo para iniciar hoy?";
};

const deterministicReply = (agent: AgentName, message: string, history?: ChatHistoryItem[]): string | null => {
  const text = normalize(message);
  const serviceIntent = inferServiceIntentFromContext(message, history);
  const email = extractEmail(message);
  const phone = extractPhone(message);

  if (isThanks(message)) {
    if (alreadyCapturedInHistory(history)) {
      return "Gracias a ti. Quedo todo registrado y hoy te contactamos por correo y WhatsApp para iniciar el kickoff.";
    }

    if (agent === "proposal") {
      return "Gracias. Si quieres, seguimos: comparteme objetivo, plazo y presupuesto y te dejo una propuesta inicial lista hoy.";
    }

    return "Gracias por escribirnos. Si quieres, dime que necesitas y lo resolvemos paso a paso.";
  }

  if (agent === "proposal" && (email || phone)) {
    const captured = alreadyCapturedInHistory(history);
    if (email && phone) {
      if (!captured) {
        void persistProposalHandoff({ email, phone, serviceIntent, history }).catch((error) => {
          console.error("[AI CHAT] proposal handoff persistence failed", error);
        });
      }
      return "Perfecto, datos recibidos. Hoy te enviamos propuesta formal al correo y te contactamos por WhatsApp para kickoff.";
    }
    if (email) {
      return "Excelente, ya tengo tu correo. Comparte tambien tu WhatsApp para coordinar kickoff mas rapido.";
    }
    return "Excelente, ya tengo tu WhatsApp. Comparte tambien tu correo para enviarte la propuesta formal.";
  }

  if (serviceIntent !== "none") {
    if (serviceIntent === "web_landing" && agent === "landing") {
      return null;
    }
    const followUp = serviceFollowUpReply(serviceIntent, message, history);
    if (followUp) {
      return followUp;
    }
    return formatCatalogReply(SERVICE_CATALOG[serviceIntent], message, history);
  }

  if (hasAny(text, ["presupuesto", "cotiz", "precio", "cuanto cuesta", "cuánto cuesta"])) {
    return `Claro. En Vytronix cada servicio tiene valores distintos:\n- Landing: desde ${clp(LANDING_PRICE_BASE_CLP)} + IVA\n- Sitio web: ${clp(WEBSITE_MIN_CLP)} a ${clp(WEBSITE_MAX_CLP)} + IVA\n- E-commerce con carrito: ${clp(ECOMMERCE_MIN_CLP)} a ${clp(ECOMMERCE_MAX_CLP)} + IVA\n- Integraciones/APIs: ${clp(INTEGRATION_API_MIN_CLP)} a ${clp(INTEGRATION_API_MAX_CLP)} + IVA\n- App movil: ${clp(MOBILE_APP_MIN_CLP)} a ${clp(MOBILE_APP_MAX_CLP)} + IVA\n- VyAudit: ${clp(VYAUDIT_PRICE_CLP)} por dominio\n- Marketing digital: ${clp(MARKETING_BASIC_CLP)} / ${clp(MARKETING_MEDIUM_CLP)} / ${clp(MARKETING_ADVANCED_CLP)} + IVA\n\nDime cual servicio necesitas y te doy una estimacion mas precisa.`;
  }

  if (hasAny(text, ["ejecutivo", "asesor", "hablar con", "llamada"])) {
    return "Perfecto, te conecto con un ejecutivo comercial. Comparte tu nombre, correo, WhatsApp y que necesitas resolver primero.";
  }

  if (agent === "support" && hasAny(text, ["no puedo", "error", "acceso", "bloqueado"])) {
    return "Entiendo. Te ayudo con soporte: confirma tu correo de cuenta, producto afectado y desde cuando ocurre para priorizar el caso.";
  }

  return null;
};

const timeoutFallbackReply = (agent: AgentName, message: string, history?: ChatHistoryItem[]): string => {
  const deterministic = deterministicReply(agent, message, history);
  if (deterministic) {
    return deterministic;
  }

  switch (agent) {
    case "proposal":
      return "El motor esta lento, pero avanzamos igual. Comparte objetivo, plazo y presupuesto estimado, y te preparo una propuesta base ahora.";
    case "support":
      return "El motor esta ocupado. Para no frenar, dime producto afectado, error exacto y prioridad, y te doy siguiente paso inmediato.";
    case "lead":
      return "Estoy procesando tu solicitud. Si quieres avanzar ya, comparte objetivo comercial, rubro y plazo, y te guio de inmediato.";
    default:
      return "Estoy procesando tu solicitud. Intenta nuevamente en unos segundos.";
  }
};

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Solicitud invalida" }, { status: 400 });
  }

  if (!isAiEngineEnabled()) {
    return NextResponse.json({ success: false, error: "Asistente AI no disponible" }, { status: 503 });
  }

  const session = getOrCreateChatSession(parsed.data.sessionId);

  if (isGreeting(parsed.data.message)) {
    saveChatSession(session);
    return NextResponse.json({
      success: true,
      sessionId: session.id,
      agent: session.currentAgent,
      reply: "Hola. Soy el asistente de Vytronix. Cuentame que necesitas y te guio paso a paso."
    });
  }

  const requestedAgent = parsed.data.agent;
  const chosenAgent = chooseAgent(parsed.data.message, requestedAgent, session.currentAgent);

  if (chosenAgent !== session.currentAgent) {
    if (chosenAgent === "landing") {
      resetLandingFlow(session);
    }
    session.currentAgent = chosenAgent;
  }

  if (chosenAgent === "landing") {
    const reply = landingFlowReply(parsed.data.message, session);
    saveChatSession(session);

    return NextResponse.json({
      success: true,
      sessionId: session.id,
      agent: "landing",
      reply
    });
  }

  const deterministic = deterministicReply(chosenAgent, parsed.data.message, parsed.data.history);
  if (deterministic) {
    saveChatSession(session);
    return NextResponse.json({
      success: true,
      sessionId: session.id,
      agent: chosenAgent,
      reply: deterministic
    });
  }

  const conversationContext = buildConversationContext(parsed.data.history);
  const runResult = await runAgentForContact(
    chosenAgent,
    {
      name: "Website Visitor",
      email: "visitor@vytronix.local",
      phone: "N/A",
      message: parsed.data.message,
      conversationContext
    },
    { timeoutMs: CHAT_TIMEOUT_MS, mode: "fast" }
  );

  if (!runResult.success || !runResult.data) {
    saveChatSession(session);
    return NextResponse.json(
      {
        success: false,
        sessionId: session.id,
        error: timeoutFallbackReply(chosenAgent, parsed.data.message, parsed.data.history)
      },
      { status: 502 }
    );
  }

  const reply = formatAgentReply(chosenAgent, runResult.data.parsedOutput);
  saveChatSession(session);

  return NextResponse.json({
    success: true,
    sessionId: session.id,
    agent: chosenAgent,
    reply,
    runId: runResult.data.runId
  });
}










