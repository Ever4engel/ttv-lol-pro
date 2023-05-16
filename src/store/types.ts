import type { AdLogEntry, StreamStatus } from "../types";

export type EventType = "load" | "change";
export type ReadyState = "loading" | "complete";
export type StorageAreaName = "local" | "managed" | "sync";

export interface State {
  adLog: AdLogEntry[];
  adLogEnabled: boolean;
  adLogLastSent: number;
  proxyUsherRequests: boolean;
  streamStatuses: Record<string, StreamStatus>;
  usherProxies: string[];
  videoWeaverProxies: string[];
  videoWeaverUrlsByChannel: Record<string, string[]>;
  whitelistedChannels: string[];
}

export const enum ProxyFlags {
  IS_PROXY = "__isProxy",
  RAW = "__raw",
}
