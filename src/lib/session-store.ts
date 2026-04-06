import { SessionMetadata, TimelineEvent, TimelineEventInput, Viewport } from "../types";
import {
  STORAGE_SESSION,
  STORAGE_EVENTS,
  STORAGE_SCREENSHOTS,
} from "../constants";

function generateId(): string {
  return crypto.randomUUID();
}

export async function createSession(
  tabId: number,
  url: string,
  viewport: Viewport,
): Promise<SessionMetadata> {
  const session: SessionMetadata = {
    id: generateId(),
    tab_id: tabId,
    start_time: new Date().toISOString(),
    end_time: null,
    duration_ms: null,
    initial_url: url,
    user_agent: navigator.userAgent,
    viewport,
  };
  await chrome.storage.local.set({
    [STORAGE_SESSION]: session,
    [STORAGE_EVENTS]: [],
    [STORAGE_SCREENSHOTS]: {},
  });
  return session;
}

export async function endSession(): Promise<SessionMetadata | null> {
  const result = await chrome.storage.local.get(STORAGE_SESSION);
  const session = result[STORAGE_SESSION] as SessionMetadata | undefined;
  if (!session) return null;

  const now = new Date();
  session.end_time = now.toISOString();
  session.duration_ms = now.getTime() - new Date(session.start_time).getTime();
  await chrome.storage.local.set({ [STORAGE_SESSION]: session });
  return session;
}

export async function getSession(): Promise<SessionMetadata | null> {
  const result = await chrome.storage.local.get(STORAGE_SESSION);
  return (result[STORAGE_SESSION] as SessionMetadata) ?? null;
}

export async function appendEvent(
  event: TimelineEventInput,
): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_EVENTS);
  const events = (result[STORAGE_EVENTS] as TimelineEvent[]) ?? [];
  const seq = events.length + 1;
  events.push({ ...event, seq } as TimelineEvent);
  await chrome.storage.local.set({ [STORAGE_EVENTS]: events });
}

export async function getEvents(): Promise<TimelineEvent[]> {
  const result = await chrome.storage.local.get(STORAGE_EVENTS);
  return (result[STORAGE_EVENTS] as TimelineEvent[]) ?? [];
}

export async function storeScreenshot(
  id: string,
  dataUrl: string,
): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_SCREENSHOTS);
  const screenshots =
    (result[STORAGE_SCREENSHOTS] as Record<string, string>) ?? {};
  screenshots[id] = dataUrl;
  await chrome.storage.local.set({ [STORAGE_SCREENSHOTS]: screenshots });
}

export async function getScreenshots(): Promise<Record<string, string>> {
  const result = await chrome.storage.local.get(STORAGE_SCREENSHOTS);
  return (result[STORAGE_SCREENSHOTS] as Record<string, string>) ?? {};
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove([
    STORAGE_SESSION,
    STORAGE_EVENTS,
    STORAGE_SCREENSHOTS,
  ]);
}
