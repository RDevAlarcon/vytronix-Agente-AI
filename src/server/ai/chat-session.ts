import { randomUUID } from "crypto";

export type AgentName = "lead" | "landing" | "proposal" | "support";

export type LandingConversationState = {
  goal?: string;
  audience?: string;
  offer?: string;
  timeline?: string;
  focus?: "conversion" | "lead_qualification";
  brand?: string;
  visualReference?: string;
  paymentMethod?: string;
  budget?: string;
  contactEmail?: string;
  contactPhone?: string;
  quoteSent: boolean;
  briefSent: boolean;
  briefClosed: boolean;
  kickoffRequested: boolean;
  handoffSent: boolean;
  completed: boolean;
};

export type ChatSession = {
  id: string;
  currentAgent: AgentName;
  updatedAt: number;
  landing: LandingConversationState;
};

const SESSION_TTL_MS = 1000 * 60 * 60 * 4;
const sessions = new Map<string, ChatSession>();

const defaultLandingState = (): LandingConversationState => ({
  quoteSent: false,
  briefSent: false,
  briefClosed: false,
  kickoffRequested: false,
  handoffSent: false,
  completed: false
});

const createSession = (): ChatSession => ({
  id: randomUUID(),
  currentAgent: "lead",
  updatedAt: Date.now(),
  landing: defaultLandingState()
});

const pruneExpired = (): void => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
};

export const getOrCreateChatSession = (sessionId?: string): ChatSession => {
  pruneExpired();

  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.updatedAt = Date.now();
      return existing;
    }
  }

  const created = createSession();
  sessions.set(created.id, created);
  return created;
};

export const saveChatSession = (session: ChatSession): void => {
  session.updatedAt = Date.now();
  sessions.set(session.id, session);
};

export const resetLandingFlow = (session: ChatSession): void => {
  session.landing = defaultLandingState();
  session.updatedAt = Date.now();
};
