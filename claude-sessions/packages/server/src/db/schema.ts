// AI-generated. See PROMPT.md for the prompts and model used.

import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    return JSON.parse(value as string);
  },
});

const textArray = customType<{ data: string[]; driverData: string[] }>({
  dataType() {
    return "text[]";
  },
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const repos = pgTable("repos", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  canonicalUrl: text("canonical_url").notNull().unique(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const userRepos = pgTable(
  "user_repos",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    access: text("access").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.repoId] }) }),
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id").references(() => repos.id),
    agent: text("agent").notNull(),
    agentVersion: text("agent_version").notNull(),
    branch: text("branch"),
    sourceCwdHint: text("source_cwd_hint").notNull(),
    model: text("model"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }).notNull(),
    totalInputTokens: integer("total_input_tokens").notNull().default(0),
    totalOutputTokens: integer("total_output_tokens").notNull().default(0),
    totalCostUsd: numeric("total_cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    permissionMode: text("permission_mode"),
    isPrivate: boolean("is_private").notNull().default(false),
    name: text("name"),
    hasBlob: boolean("has_blob").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({
    userRepoIdx: index("idx_sessions_user_repo").on(t.userId, t.repoId),
    repoBranchIdx: index("idx_sessions_repo_branch").on(t.repoId, t.branch),
    startedAtIdx: index("idx_sessions_started_at").on(t.startedAt),
  }),
);

export const events = pgTable(
  "events",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    eventUuid: text("event_uuid").notNull(),
    parentUuid: text("parent_uuid"),
    ts: timestamp("ts", { withTimezone: true, mode: "date" }).notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sessionId, t.eventUuid] }),
    sessionTsIdx: index("idx_events_session_ts").on(t.sessionId, t.ts),
  }),
);

export const summaries = pgTable("summaries", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  title: text("title"),
  summary: text("summary"),
  tags: textArray("tags").notNull().default(sql`'{}'::text[]`),
  filesTouched: textArray("files_touched").notNull().default(sql`'{}'::text[]`),
  prsReferenced: textArray("prs_referenced").notNull().default(sql`'{}'::text[]`),
  toolCallCounts: jsonb("tool_call_counts").notNull().default({}),
  generatedAt: timestamp("generated_at", { withTimezone: true, mode: "date" }),
  model: text("model"),
  status: text("status").notNull().default("pending"),
  error: text("error"),
});

export const embeddings = pgTable("embeddings", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  embedding: vector("embedding").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const sessionBlobs = pgTable("session_blobs", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  jsonlBytes: bytea("jsonl_bytes").notNull(),
  byteSize: integer("byte_size").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const sessionPrLinks = pgTable(
  "session_pr_links",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    prUrl: text("pr_url").notNull(),
    source: text("source").notNull(),
    validatedAt: timestamp("validated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.sessionId, t.prUrl] }) }),
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    targetSessionId: text("target_session_id"),
    ts: timestamp("ts", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    detail: jsonb("detail"),
  },
  (t) => ({ actorTsIdx: index("idx_audit_actor_ts").on(t.actorUserId, t.ts) }),
);
