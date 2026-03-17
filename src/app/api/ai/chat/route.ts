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

const scoreSignals = (text: string, signals: string[]): number =>
  signals.reduce((score, signal) => score + (text.includes(signal) ? 1 : 0), 0);

const scoreWordSignals = (text: string, signals: string[]): number =>
  signals.reduce((score, signal) => score + (hasWord(text, signal) ? 1 : 0), 0);

const detectServiceIntent = (message: string): ServiceIntent => {
  const text = normalize(message);

  if (hasAny(text, ["landing", "landing page"])) {
    return "web_landing";
  }
  if (hasAny(text, ["ecommerce", "e-commerce", "tienda online", "carrito", "checkout", "carro de compras", "carrito de compras"])) {
    return "ecommerce";
  }
  if (hasAny(text, ["integracion", "integraciones", "integrar pagos", "pasarela de pago", "webhook", "crm", "erp"]) || hasWord(text, "api") || hasWord(text, "apis")) {
    return "integrations_api";
  }
  if (hasAny(text, ["app movil", "aplicacion movil", "app mobile"]) || scoreWordSignals(text, ["ios", "android"]) > 0 || hasWord(text, "app")) {
    return "mobile_apps";
  }
  if (hasAny(text, ["marketing digital", "meta ads", "google ads", "campanas", "campa?as", "redes sociales"])) {
    return "marketing_digital";
  }
  if (hasAny(text, ["vyaudit", "auditoria web", "auditoria de sitio", "seo tecnico", "core web vitals"])) {
    return "vyaudit";
  }

  const scores: Record<Exclude<ServiceIntent, "none">, number> = {
    vyaudit: 0,
    ecommerce: 0,
    integrations_api: 0,
    marketing_digital: 0,
    mobile_apps: 0,
    web_landing: 0
  };

  scores.vyaudit += scoreSignals(text, [
    "vyaudit",
    "auditoria web",
    "auditoria de sitio",
    "seo tecnico",
    "core web vitals",
    "lighthouse",
    "performance web",
    "accesibilidad web",
    "informe pdf"
  ]);

  scores.ecommerce += scoreSignals(text, [
    "ecommerce",
    "e-commerce",
    "tienda online",
    "carrito",
    "carro de compras",
    "checkout",
    "catalogo",
    "catalogo de productos",
    "productos",
    "comprar online"
  ]);

  scores.integrations_api += scoreSignals(text, [
    "integracion",
    "integraciones",
    "crm",
    "erp",
    "webhook",
    "sincronizacion",
    "conectar sistemas",
    "pasarela de pago",
    "integrar pagos",
    "automatizacion"
  ]);
  if (hasWord(text, "api") || hasWord(text, "apis")) {
    scores.integrations_api += 2;
  }

  scores.marketing_digital += scoreSignals(text, [
    "marketing digital",
    "ads",
    "meta ads",
    "google ads",
    "campanas",
    "campa?as",
    "trafico",
    "contenido",
    "redes sociales"
  ]);

  scores.mobile_apps += scoreSignals(text, [
    "app movil",
    "aplicacion movil",
    "aplicacion mobile",
    "app mobile",
    "play store",
    "app store"
  ]);
  scores.mobile_apps += scoreWordSignals(text, ["ios", "iphone", "apk", "android"]);
  if (hasWord(text, "app")) {
    scores.mobile_apps += 2;
  }

  scores.web_landing += scoreSignals(text, [
    "landing",
    "landing page",
    "pagina web",
    "sitio web",
    "pagina corporativa",
    "sitio corporativo",
    "web corporativa",
    "one page",
    "ofrecer servicios",
    "ofrecer mis servicios",
    "web"
  ]);

  if (hasAny(text, ["mercado pago", "webpay"])) {
    if (hasAny(text, ["carrito", "checkout", "tienda", "ecommerce", "catalogo", "productos"])) {
      scores.ecommerce += 2;
    }
    if (hasAny(text, ["integrar", "integracion", "api", "webhook", "sistema"])) {
      scores.integrations_api += 2;
    }
  }

  if (hasAny(text, ["carrito de compras", "carro de compras"])) {
    scores.ecommerce += 3;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  if (!ranked[0] || ranked[0][1] <= 0) {
    return "none";
  }

  return ranked[0][0] as ServiceIntent;
};

const isCorporateWebsiteIntent = (message: string): boolean => {
  const text = normalize(message);
  return hasAny(text, [
    "sitio web corporativo",
    "pagina corporativa",
    "sitio corporativo",
    "web corporativa",
    "ofrecer servicios",
    "ofrecer mis servicios",
    "mostrar servicios",
    "presentar servicios"
  ]);
};

const isGenericWebsiteRequest = (message: string): boolean => {
  const text = normalize(message);
  const hasGenericWebSignal = hasAny(text, [
    "pagina web",
    "sitio web",
    "crear una web",
    "crear pagina",
    "hacer una web",
    "necesito una web",
    "quiero una web",
    "pagina para mi negocio",
    "sitio para mi negocio"
  ]) || hasWord(text, "web");

  if (!hasGenericWebSignal) {
    return false;
  }

  const hasSpecificSignal =
    hasAny(text, [
      "landing",
      "landing page",
      "sitio web corporativo",
      "pagina corporativa",
      "sitio corporativo",
      "web corporativa",
      "tienda online",
      "ecommerce",
      "e-commerce",
      "carrito",
      "checkout",
      "catalogo",
      "productos",
      "integracion",
      "integrar",
      "webhook",
      "crm",
      "erp",
      "mercado pago",
      "webpay",
      "app movil",
      "aplicacion movil",
      "marketing digital",
      "ads",
      "vyaudit",
      "auditoria"
    ]) ||
    hasWord(text, "api") ||
    hasWord(text, "android") ||
    hasWord(text, "ios") ||
    hasWord(text, "seo");

  return !hasSpecificSignal;
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
  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes("@"))
    .filter((line) => !line.includes("whatsapp"))
    .filter((line) => !line.includes("telefono"))
    .filter((line) => !line.includes("tel:"));

  for (const line of lines) {
    const mentionsMoney = hasAny(line, ["presupuesto", "clp", "peso", "pesos", "millon", "millones", "mil"]) || line.includes("$");

    const compact = line.match(/(?:\$\s*)?(\d{1,3}(?:[.\s]\d{3})+)/);
    if (compact?.[1]) {
      const digits = compact[1].replace(/[.\s]/g, "");
      const value = Number(digits);
      if (Number.isFinite(value) && value >= 100000) {
        return value;
      }
    }

    if (!mentionsMoney) {
      continue;
    }

    const plainAmount = line.match(/\b([1-9]\d{5,7})\b/);
    if (plainAmount?.[1]) {
      const value = Number(plainAmount[1]);
      if (Number.isFinite(value) && value >= 100000 && value <= 50000000) {
        return value;
      }
    }
  }

  return null;
};

const detectUrgencyMultiplier = (text: string): number => {
  const normalized = normalize(text);

  if (hasAny(normalized, ["urgente", "asap", "hoy", "24h", "24 h", "manana", "mañana"])) {
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

type WebQuoteType = "landing_page" | "corporate_website";

type ServiceQuoteResult = {
  estimatedPrice: string;
  totalClp: number | null;
  lineItems: string[];
};

const buildUserContextText = (message: string, history?: ChatHistoryItem[]): string =>
  [...(history ?? []).filter((item) => item.role === "user").map((item) => item.text), message].join("\n");

const roundQuoteClp = (value: number): number => Math.round(value / 10000) * 10000;

const clampQuote = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const parseInitialProductCount = (text: string): number | null => {
  const normalized = normalize(text);
  const match = normalized.match(/\b(\d{1,4})\s+(productos|producto|sku|items?)\b/);
  if (!match?.[1]) {
    return null;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const countSignalsPresent = (text: string, signals: string[]): number => signals.filter((signal) => text.includes(signal)).length;

const detectWebsiteQuoteType = (message: string, history?: ChatHistoryItem[]): WebQuoteType => {
  const text = buildUserContextText(message, history);
  const normalized = normalize(text);

  if (hasAny(normalized, ["landing", "landing page", "captar leads", "conversion", "conversi", "reuniones"])) {
    return "landing_page";
  }

  if (isCorporateWebsiteIntent(normalized)) {
    return "corporate_website";
  }

  return "landing_page";
};

const buildRangeText = (totalClp: number, complexity: "baja" | "media" | "alta"): string => {
  const spreadRatio = complexity === "alta" ? 0.15 : complexity === "media" ? 0.12 : 0.1;
  const spread = Math.max(roundQuoteClp(totalClp * spreadRatio), 40000);
  const rangeMin = Math.max(0, totalClp - spread);
  const rangeMax = totalClp + spread;
  return `${clp(rangeMin)} a ${clp(rangeMax)} + IVA`;
};

const buildLineItemSummary = (lineItems: string[]): string => {
  if (lineItems.length === 0) {
    return "";
  }

  return ` Desglose base: ${lineItems.join(", ")}.`;
};

const inferCommercialServiceLabel = (intent: ServiceIntent, message?: string, history?: ChatHistoryItem[]): string => {
  switch (intent) {
    case "web_landing":
      return detectWebsiteQuoteType(message ?? "", history) === "corporate_website" ? "Sitio web corporativo" : "Landing page";
    case "ecommerce":
      return "E-commerce con carrito";
    case "integrations_api":
      return "Integraciones y APIs";
    case "mobile_apps":
      return "Aplicacion movil";
    case "marketing_digital":
      return "Marketing digital";
    case "vyaudit":
      return "VyAudit (auditoria web)";
    default:
      return "Servicio no definido";
  }
};

const estimateServiceQuote = (
  entry: ServiceCatalogEntry,
  intent: Exclude<ServiceIntent, "none">,
  message: string,
  history?: ChatHistoryItem[]
): ServiceQuoteResult => {
  if (typeof entry.fixedPriceClp === "number") {
    return {
      estimatedPrice: `Valor referencial fijo: ${clp(entry.fixedPriceClp)} + IVA.`,
      totalClp: entry.fixedPriceClp,
      lineItems: [`Auditoria por dominio ${clp(entry.fixedPriceClp)}`]
    };
  }

  const contextText = buildUserContextText(message, history);
  const normalized = normalize(contextText);
  const complexity = detectComplexity(contextText);
  const urgencyMultiplier = detectUrgencyMultiplier(contextText);
  const budget = parseBudgetClpFromText(contextText);
  const lineItems: string[] = [];

  let subtotal = 0;
  const addLineItem = (label: string, amount: number) => {
    if (amount <= 0) {
      return;
    }

    const roundedAmount = roundQuoteClp(amount);
    subtotal += roundedAmount;
    lineItems.push(`${label} ${clp(roundedAmount)}`);
  };

  if (intent === "web_landing") {
    const websiteType = detectWebsiteQuoteType(message, history);

    if (websiteType === "landing_page") {
      addLineItem("Landing base", LANDING_PRICE_BASE_CLP);
      if (hasAny(normalized, ["ventas", "captar leads", "lead", "conversion", "conversi", "reuniones"])) {
        addLineItem("Setup estrategico", LANDING_PRICE_SETUP_CLP);
      }
      if (hasAny(normalized, ["productos", "catalogo", "servicios", "beneficios"])) {
        addLineItem("Secciones comerciales", 60000);
      }
      if (complexity === "media") {
        addLineItem("Ajuste de complejidad media", 80000);
      }
      if (complexity === "alta") {
        addLineItem("Ajuste de complejidad alta", 160000);
      }
    } else {
      addLineItem("Sitio corporativo base", WEBSITE_MIN_CLP);
      if (hasAny(normalized, ["servicio", "servicios", "empresa", "corporativo", "nosotros", "quienes somos"])) {
        addLineItem("Arquitectura comercial de servicios", 90000);
      }
      if (hasAny(normalized, ["contacto", "formulario", "lead", "reuniones"])) {
        addLineItem("Captacion y formularios", 70000);
      }
      if (hasAny(normalized, ["productos", "catalogo", "portafolio", "casos de exito"])) {
        addLineItem("Seccion catalogo o portafolio", 120000);
      }
      if (complexity === "media") {
        addLineItem("Ajuste de complejidad media", 150000);
      }
      if (complexity === "alta") {
        addLineItem("Ajuste de complejidad alta", 320000);
      }
    }
  }

  if (intent === "ecommerce") {
    addLineItem("E-commerce base", ECOMMERCE_MIN_CLP);
    const productCount = parseInitialProductCount(contextText);
    if (productCount && productCount <= 10) {
      addLineItem("Configuracion de catalogo inicial", 70000);
    }
    if (productCount && productCount > 10 && productCount <= 50) {
      addLineItem("Catalogo medio", 180000);
    }
    if (productCount && productCount > 50) {
      addLineItem("Catalogo amplio", 450000);
    }

    const paymentGateways = countSignalsPresent(normalized, ["mercado pago", "webpay", "stripe", "paypal", "flow", "khipu"]);
    if (paymentGateways > 0) {
      addLineItem("Integracion de medio de pago", 250000);
      if (paymentGateways > 1) {
        addLineItem("Medio de pago adicional", 100000 * (paymentGateways - 1));
      }
    }
    if (hasAny(normalized, ["stock", "inventario", "pedido", "pedidos"])) {
      addLineItem("Gestion operativa", 180000);
    }
    if (complexity === "media") {
      addLineItem("Ajuste de complejidad media", 220000);
    }
    if (complexity === "alta") {
      addLineItem("Ajuste de complejidad alta", 520000);
    }
  }

  if (intent === "integrations_api") {
    addLineItem("Integracion base", INTEGRATION_API_MIN_CLP);
    const extraSystems = countSignalsPresent(normalized, ["crm", "erp", "ecommerce", "tienda", "pasarela", "mercado pago", "webpay"]);
    if (extraSystems > 1) {
      addLineItem("Sistemas adicionales", 180000 * (extraSystems - 1));
    }
    if (hasAny(normalized, ["webhook", "tiempo real", "real time", "sincronizacion"])) {
      addLineItem("Sincronizacion en tiempo real", 180000);
    }
    if (hasAny(normalized, ["dashboard", "reportes", "reporteria"])) {
      addLineItem("Tablero o reporteria", 120000);
    }
    if (complexity === "media") {
      addLineItem("Ajuste de complejidad media", 180000);
    }
    if (complexity === "alta") {
      addLineItem("Ajuste de complejidad alta", 500000);
    }
  }

  if (intent === "mobile_apps") {
    addLineItem("Aplicacion movil base", MOBILE_APP_MIN_CLP);
    if (hasAny(normalized, ["vender", "venta online", "productos", "catalogo", "carrito", "checkout"])) {
      addLineItem("Modulo comercial o catalogo", 450000);
    }
    if (hasAny(normalized, ["mercado pago", "webpay", "stripe", "pasarela", "suscripcion"])) {
      addLineItem("Pagos o monetizacion", 280000);
    }
    if (hasAny(normalized, ["dashboard", "admin", "panel", "backoffice"])) {
      addLineItem("Panel de gestion", 250000);
    }
    if (complexity === "media") {
      addLineItem("Ajuste de complejidad media", 550000);
    }
    if (complexity === "alta") {
      addLineItem("Ajuste de complejidad alta", 1600000);
    }
  }

  if (intent === "marketing_digital") {
    let monthlyPlan = MARKETING_MEDIUM_CLP;
    if (budget && budget <= MARKETING_BASIC_CLP) {
      monthlyPlan = MARKETING_BASIC_CLP;
    } else if (budget && budget >= MARKETING_ADVANCED_CLP) {
      monthlyPlan = MARKETING_ADVANCED_CLP;
    } else if (hasAny(normalized, ["ventas", "ads", "google ads", "meta ads", "ecommerce"])) {
      monthlyPlan = MARKETING_ADVANCED_CLP;
    }

    addLineItem("Plan mensual recomendado", monthlyPlan);
    if (!budget) {
      addLineItem("Diagnostico inicial", MARKETING_DIAGNOSTIC_CLP);
    }
  }

  if (subtotal <= 0) {
    if (typeof entry.minPriceClp === "number") {
      subtotal = entry.minPriceClp;
    } else {
      return { estimatedPrice: entry.priceNote, totalClp: null, lineItems: [] };
    }
  }

  const urgencyCharge = urgencyMultiplier > 1 ? roundQuoteClp(subtotal * (urgencyMultiplier - 1)) : 0;
  if (urgencyCharge > 0) {
    subtotal += urgencyCharge;
    lineItems.push(`Prioridad por plazo ${clp(urgencyCharge)}`);
  }

  const entryMin = entry.minPriceClp ?? subtotal;
  const entryCap = entry.maxPriceClp ? Math.round(entry.maxPriceClp * 1.15) : subtotal;
  let totalClp = clampQuote(roundQuoteClp(subtotal), entryMin, Math.max(entryCap, entryMin));

  if (budget && budget >= entryMin * 0.7 && budget <= Math.max(entryCap, entryMin)) {
    totalClp = roundQuoteClp(totalClp * 0.75 + budget * 0.25);
  }

  const range = buildRangeText(totalClp, complexity);
  const urgencyTag = urgencyMultiplier > 1 ? ", con prioridad por plazo" : "";

  return {
    totalClp,
    estimatedPrice: `Estimacion afinada segun alcance conversado (complejidad ${complexity}${urgencyTag}): ${range}.${buildLineItemSummary(lineItems)}`,
    lineItems
  };
};

const estimateServicePrice = (entry: ServiceCatalogEntry, intent: Exclude<ServiceIntent, "none">, message: string, history?: ChatHistoryItem[]): string =>
  estimateServiceQuote(entry, intent, message, history).estimatedPrice;

const estimateServiceTotalClp = (
  entry: ServiceCatalogEntry,
  intent: Exclude<ServiceIntent, "none">,
  message: string,
  history?: ChatHistoryItem[]
): number | null => estimateServiceQuote(entry, intent, message, history).totalClp;

const formatCatalogReply = (
  entry: ServiceCatalogEntry,
  intent: Exclude<ServiceIntent, "none">,
  message: string,
  history?: ChatHistoryItem[]
): string => {
  const commercialLabel = inferCommercialServiceLabel(intent, message, history);
  return `${commercialLabel}: ${entry.offer}\n${estimateServicePrice(entry, intent, message, history)}\n${entry.priceNote}\nPregunta clave: ${entry.qualifierQuestion}\n${entry.cta}`;
};

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

const inferServiceLabel = (intent: ServiceIntent, message?: string, history?: ChatHistoryItem[]): string =>
  inferCommercialServiceLabel(intent, message, history);

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
  const joinedUserText = (params.history ?? [])
    .filter((h) => h.role === "user")
    .map((h) => h.text)
    .join("\n");
  const serviceLabel = inferServiceLabel(resolvedIntent, joinedUserText || "", params.history);

  const userTurns = (params.history ?? [])
    .filter((h) => h.role === "user")
    .slice(-6)
    .map((h) => `- ${h.text}`)
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
  const estimatedPrice = estimateServicePrice(catalog, resolvedIntent, joinedUserText || message, params.history);
  const totalClp = estimateServiceTotalClp(catalog, resolvedIntent, joinedUserText || message, params.history);
  const totalEstimate = totalClp ? `${clp(totalClp)} + IVA` : undefined;
  const clientSummary = [
    `Servicio recomendado: ${serviceLabel}.`,
    timelineDetected ? `Plazo conversado: ${timelineDetected}.` : "Plazo: por confirmar.",
    budgetDetected ? `Presupuesto conversado: ${clp(budgetDetected)}.` : "Presupuesto: por confirmar.",
    "Esta propuesta es referencial y se ajusta al alcance final confirmado en kickoff."
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
  const intro = formatCatalogReply(SERVICE_CATALOG[serviceIntent], serviceIntent, message, history);
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

  const intent = detectServiceIntent(message);
  if (intent === "web_landing") {
    return isCorporateWebsiteIntent(message) ? "proposal" : "landing";
  }
  if (["ecommerce", "integrations_api", "marketing_digital", "mobile_apps", "vyaudit"].includes(intent)) {
    return "proposal";
  }

  if (hasAny(text, ["propuesta", "cotiz", "presupuesto", "precio", "plan", "oferta"])) {
    return "proposal";
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

  if (current === "landing" && explicit !== "landing") {
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

  const parsedBudget = parseBudgetClpFromText(message);
  if (parsedBudget) {
    state.budget = clp(parsedBudget);
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

const landingFlowReply = (
  message: string,
  session: ReturnType<typeof getOrCreateChatSession>,
  history?: ChatHistoryItem[]
): string => {
  const state = session.landing;

  if (
    !state.goal &&
    !state.audience &&
    !state.offer &&
    !state.timeline &&
    !state.focus &&
    !state.quoteSent &&
    isGenericWebsiteRequest(message)
  ) {
    return "Te ayudo. Para orientarte bien, dime cual de estas opciones se parece mas a lo que necesitas: landing para vender/captar leads, sitio web corporativo para mostrar servicios, ecommerce con carrito o integracion de pagos/API.";
  }

  updateLandingStateFromMessage(message, state);

  if (state.completed) {
    if (isThanks(message)) {
      return "Gracias a ti. Quedo todo registrado y hoy te contactamos por correo y WhatsApp para iniciar el kickoff.";
    }
    if (isAffirmative(message)) {
      return "Perfecto, quedo todo confirmado. En breve te contactamos para iniciar kickoff y mockup.";
    }
    return "Ya tengo todos tus datos y el inicio quedo confirmado. Si quieres, te comparto el resumen final del brief.";
  }

  if (state.kickoffRequested && state.contactEmail && state.contactPhone) {
    if (!state.handoffSent) {
      state.handoffSent = true;
      void persistProposalHandoff({
        email: state.contactEmail,
        phone: state.contactPhone,
        serviceIntent: "web_landing",
        history
      }).catch((error) => {
        console.error("[AI CHAT] landing handoff persistence failed", error);
      });
    }

    state.completed = true;
    return "Perfecto, datos recibidos. Ya dejamos agendado el kickoff. Te enviaremos confirmacion por correo y WhatsApp y empezamos con mockup y estructura final.";
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

  if (!state.budget) {
    return "Perfecto. Para ajustar la propuesta y dejar una estimacion mas realista, cual es tu presupuesto estimado?";
  }

  if (!state.quoteSent) {
    state.quoteSent = true;
    return `Perfecto. Ya tengo objetivo, publico, oferta, plazo y presupuesto.\n\nEstimacion referencial:\n- Landing page: desde ${clp(LANDING_PRICE_BASE_CLP)} + IVA\n- Setup estrategico (opcional): ${clp(LANDING_PRICE_SETUP_CLP)} + IVA\n\nSi quieres, te preparo el brief + propuesta en el siguiente mensaje.`;
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
    return "Excelente, brief cerrado. Resumen confirmado: marca, referencia visual, medio de pago, enfoque y presupuesto. Quieres que lo dejemos listo para iniciar hoy?";
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
    return formatCatalogReply(SERVICE_CATALOG[serviceIntent], serviceIntent, message, history);
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

  if (
    requestedAgent === "auto" &&
    isGenericWebsiteRequest(parsed.data.message) &&
    (session.currentAgent === "lead" || startsNewIntent(parsed.data.message))
  ) {
    resetLandingFlow(session);
    session.currentAgent = "lead";
    saveChatSession(session);
    return NextResponse.json({
      success: true,
      sessionId: session.id,
      agent: "lead",
      reply: "Te ayudo. Para orientarte bien, dime cual de estas opciones se parece mas a lo que necesitas: landing para vender/captar leads, sitio web corporativo para mostrar servicios, ecommerce con carrito o integracion de pagos/API."
    });
  }

  const chosenAgent = chooseAgent(parsed.data.message, requestedAgent, session.currentAgent);

  if (chosenAgent !== session.currentAgent) {
    if (chosenAgent === "landing") {
      resetLandingFlow(session);
    }
    session.currentAgent = chosenAgent;
  }

  if (chosenAgent === "landing") {
    const reply = landingFlowReply(parsed.data.message, session, parsed.data.history);
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





















