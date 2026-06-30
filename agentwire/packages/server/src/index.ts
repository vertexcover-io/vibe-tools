// AI-generated. See PROMPT.md for the prompts and model used.
export { attachWsServer, type WsDeps, type PiSessionLike } from "./ws-server.ts";
export { createRestServer, type RestAdapter, type RestDeps } from "./rest-server.ts";
export { startServer, buildServerDeps, type ServerDeps } from "./server.ts";
export {
  SessionRegistry,
  AtCapacityError,
  SessionBusyError,
  UnknownSessionError,
} from "./registry.ts";
export { type Config, PKG_DIR, DEFAULT_PI_AGENT_DIR } from "./config.ts";
export { createSession, openSession, toServerFrame, type ServerFrame } from "./pi-adapter.ts";
export {
  buildPiRestAdapter,
  sessionFileFor,
  type SessionLister,
  type SessionInfoLike,
} from "./pi-rest-adapter.ts";
