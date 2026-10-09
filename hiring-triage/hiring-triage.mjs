#!/usr/bin/env node
/* AI-generated. */
// Hiring triage server — Node 18+. Notion via fetch, Gmail via @googleapis/gmail.
// Usage: node hiring-triage.mjs        start the server
//        node hiring-triage.mjs auth   one-time Google sign-in; saves GOOGLE_REFRESH_TOKEN to .env
// Endpoints:
//   GET    /                             → hiring-triage.html
//   GET    /api/candidates?status=...    → list $POSITION profiles by Status (default "Not started")
//   PATCH  /api/candidates/:id           → update {score, scoreReason, status, email}
//   DELETE /api/candidates/:id           → archive (trash) the Notion page
//   POST   /api/candidates/:id/reject    → send rejection mail via Gmail + flip status
//   GET    /api/candidates/:id/resume    → proxy the resume PDF inline

import { createServer } from "node:http";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gmail as gmailApi, auth as googleAuth } from "@googleapis/gmail";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from this folder. Variables already set in the environment win.
function loadDotEnv(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    process.env[m[1]] = value;
  }
}
const ENV_FILE = join(__dirname, ".env");
loadDotEnv(ENV_FILE);

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
// Loopback redirect for a "Desktop app" OAuth client. Nothing needs to listen on it:
// the browser fails to load the page, and the user pastes the URL (with ?code=) back.
const AUTH_REDIRECT = "http://localhost:53682";

if (process.argv[2] === "auth") {
  await runGoogleAuth();
  process.exit(0);
}

const PORT = Number(process.env.PORT || 3737);
const NOTION_VERSION = "2025-09-03";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in ${join(__dirname, ".env")} (see .env.example).`);
  return value;
}

const NOTION_TOKEN = required("NOTION_TOKEN");
const NOTION_DATA_SOURCE_ID = required("NOTION_DATA_SOURCE_ID");
const POSITION = process.env.POSITION || "AI Engineer";
const COMPANY_NAME = process.env.COMPANY_NAME || "";
const SENDER_NAME = process.env.SENDER_NAME || "";
const GMAIL_FROM = process.env.GMAIL_FROM || undefined;
const REJECT_TEMPLATE = process.env.REJECT_TEMPLATE || undefined;

// ---------- Notion ----------

async function notion(path, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

function plainText(prop) {
  if (!prop) return "";
  if (prop.type === "title") return prop.title.map((t) => t.plain_text).join("").trim();
  if (prop.type === "rich_text") return prop.rich_text.map((t) => t.plain_text).join("").trim();
  return "";
}

function mapPage(page) {
  const p = page.properties;
  const filesProp = p.Resume;
  const rejDate = p["Reject Mail Sent At"];
  return {
    id: page.id,
    name: plainText(p.Name) || "(no name)",
    github: p.Github?.url ?? null,
    linkedin: p.Linkedin?.url ?? null,
    profileUrl: p["Profile URL"]?.url ?? null,
    email: p.Email?.email ?? null,
    score: p.Score?.number ?? null,
    scoreReason: plainText(p["Score Reason"]),
    source: p.Source?.select?.name ?? null,
    status: p.Status?.status?.name ?? "Not started",
    hasResume: (filesProp?.files?.length ?? 0) > 0,
    createdTime: page.created_time,
    rejectMailSentAt: rejDate?.date?.start ?? null,
    notionUrl: page.url,
  };
}

async function listCandidates(status = "Not started") {
  const body = {
    filter: {
      and: [
        { property: "Position", select: { equals: POSITION } },
        { property: "Status", status: { equals: status } },
      ],
    },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 100,
  };
  const all = [];
  let cursor;
  do {
    const r = await notion(`/data_sources/${NOTION_DATA_SOURCE_ID}/query`, {
      method: "POST",
      body: cursor ? { ...body, start_cursor: cursor } : body,
    });
    all.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return all.map(mapPage);
}

async function getCandidate(id) {
  const page = await notion(`/pages/${id}`);
  return mapPage(page);
}

async function updateCandidate(id, patch) {
  const props = {};
  if (patch.score !== undefined) props.Score = { number: patch.score };
  if (patch.scoreReason !== undefined) {
    props["Score Reason"] = { rich_text: [{ type: "text", text: { content: patch.scoreReason } }] };
  }
  if (patch.status !== undefined) props.Status = { status: { name: patch.status } };
  if (patch.email !== undefined) props.Email = { email: patch.email || null };
  if (patch.rejectMailSentAt !== undefined) {
    props["Reject Mail Sent At"] = { date: { start: patch.rejectMailSentAt } };
  }
  const page = await notion(`/pages/${id}`, { method: "PATCH", body: { properties: props } });
  return mapPage(page);
}

// Archive (trash) a candidate page. Notion has no hard-delete via API — `archived: true`
// moves the page to trash, where it can be restored from the Notion UI if needed.
async function deleteCandidate(id) {
  let candidate;
  try { candidate = await getCandidate(id); } catch { candidate = { id, name: id }; }
  await notion(`/pages/${id}`, { method: "PATCH", body: { archived: true } });
  await recordDecision(candidate, "delete");
  return { id };
}

async function getResumeSignedUrl(id) {
  const page = await notion(`/pages/${id}`);
  const f = page.properties.Resume?.files?.[0];
  if (!f) return null;
  if (f.type === "file") return f.file.url;
  if (f.type === "external") return f.external.url;
  return null;
}

// ---------- Gmail ----------

// Template format: first line "Subject: ...", a blank line, then the body.
// Placeholders: {first} {name} {position} {company} {sender}
const DEFAULT_REJECT_TEMPLATE = `Subject: Update on your {company} application

Hi {first},

Thanks so much for applying to the {position} role at {company} and for taking the time to share your background with us.

After reviewing your profile, we won't be able to move forward at this time. This isn't a reflection on your skills — we're optimizing for a specific shape of fit right now and get far more strong applications than we can take on.

We'll keep your details on file and reach out if something more aligned opens up. Wishing you the best for what's next.

Best,
{sender}
{company}`;

const rejectTemplate = REJECT_TEMPLATE
  ? readFileSync(resolve(__dirname, REJECT_TEMPLATE), "utf8")
  : DEFAULT_REJECT_TEMPLATE;

function rejectionEmail(name) {
  const vars = {
    first: (name || "").split(/\s+/)[0] || "there",
    name: name || "",
    position: POSITION,
    company: COMPANY_NAME,
    sender: SENDER_NAME,
  };
  const filled = rejectTemplate.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  const [first, ...rest] = filled.split("\n");
  const subjectMatch = first.match(/^Subject:\s*(.*)$/i);
  if (!subjectMatch) throw new Error("Rejection template must start with a 'Subject: ...' line.");
  const body = rest.join("\n").replace(/^\s*\n/, "").replace(/\n+$/, "");
  return { subject: subjectMatch[1].trim(), body };
}

function oauthClient() {
  return new googleAuth.OAuth2(required("GOOGLE_CLIENT_ID"), required("GOOGLE_CLIENT_SECRET"), AUTH_REDIRECT);
}

let gmailClient;
function getGmail() {
  if (!gmailClient) {
    const client = oauthClient();
    client.setCredentials({ refresh_token: required("GOOGLE_REFRESH_TOKEN") });
    gmailClient = gmailApi({ version: "v1", auth: client });
  }
  return gmailClient;
}

async function sendViaGmail({ to, subject, body }) {
  if (/[\r\n]/.test(to + subject + (GMAIL_FROM ?? ""))) throw new Error("newline in email header");
  const headers = [
    `To: ${to}`,
    ...(GMAIL_FROM ? [`From: ${GMAIL_FROM}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const encodedBody = Buffer.from(body).toString("base64").replace(/.{76}/g, "$&\r\n");
  const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${encodedBody}`).toString("base64url");
  const res = await getGmail().users.messages.send({ userId: "me", requestBody: { raw } });
  return { messageId: res.data.id ?? null };
}

// Replace KEY=... in .env, or append it.
function setEnvValue(key, value) {
  let text = "";
  try { text = readFileSync(ENV_FILE, "utf8"); } catch {}
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  text = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
  writeFileSync(ENV_FILE, text, { mode: 0o600 });
}

async function runGoogleAuth() {
  const client = oauthClient();
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [GMAIL_SCOPE] });
  console.log("1. Open this URL and approve sending email as your Gmail account:\n");
  console.log(`   ${url}\n`);
  console.log(`2. The browser then fails to load ${AUTH_REDIRECT}/?code=... — that's expected.`);
  console.log("   Copy that whole URL from the address bar.\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Paste it here: ")).trim();
  rl.close();
  const code = answer.startsWith("http") ? new URL(answer).searchParams.get("code") : answer;
  if (!code) throw new Error("No ?code= found in what you pasted.");
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error("Google returned no refresh token; try again.");
  setEnvValue("GOOGLE_REFRESH_TOKEN", tokens.refresh_token);
  console.log(`\nSaved GOOGLE_REFRESH_TOKEN to ${ENV_FILE}. Restart the server to use it.`);
}

// ---------- Decision log (compare your calls against the scores) ----------

// Holds candidate names and notes, so it is gitignored. Relative paths resolve from this folder.
const DECISIONS_FILE = resolve(__dirname, process.env.DECISIONS_FILE || "decisions.jsonl");

async function recordDecision(candidate, action, mismatchReason) {
  const entry = {
    ts: new Date().toISOString(),
    id: candidate.id,
    name: candidate.name,
    score: candidate.score,
    scoreReason: candidate.scoreReason || null,
    action,                                       // "accept" | "maybe" | "reject"
    source: candidate.source ?? null,
    mismatch: !!mismatchReason,
    ...(mismatchReason ? { mismatchReason } : {}),
  };
  try {
    await mkdir(dirname(DECISIONS_FILE), { recursive: true });
    await appendFile(DECISIONS_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Logging must never block the user's action.
    console.error("[decisions] failed to record:", err.message);
  }
}

const STATUS_TO_ACTION = {
  "Intro Call": "accept",
  "Hold":       "maybe",
  "Rejected":   "reject",
};

// ---------- High-level actions (used by single + bulk endpoints) ----------

async function rejectCandidate(id, mismatchReason) {
  const candidate = await getCandidate(id);
  if (!candidate.email) {
    const err = new Error("Candidate has no Email — set it in the UI before rejecting.");
    err.statusCode = 400;
    throw err;
  }
  if (candidate.rejectMailSentAt) {
    const err = new Error(`Rejection already sent at ${candidate.rejectMailSentAt}`);
    err.statusCode = 409;
    throw err;
  }
  const { subject, body } = rejectionEmail(candidate.name);
  const sendRes = await sendViaGmail({ to: candidate.email, subject, body });
  const updated = await updateCandidate(id, {
    status: "Rejected",
    rejectMailSentAt: new Date().toISOString(),
  });
  await recordDecision(updated, "reject", mismatchReason);
  return { candidate: updated, messageId: sendRes.messageId };
}

const BULK_ACTIONS = {
  accept: { status: "Intro Call", concurrency: 5 },
  maybe:  { status: "Hold",       concurrency: 5 },
  reject: { status: null,         concurrency: 3 },  // reject also sends email via Gmail
  delete: { status: null,         concurrency: 5 },  // archive (trash) the page, no email
};

// Worker-pool with bounded concurrency. Preserves input order in results.
async function runParallel(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const idx = next++;
        if (idx >= items.length) return;
        try {
          const data = await worker(items[idx], idx);
          results[idx] = { id: items[idx], ok: true, ...data };
        } catch (err) {
          results[idx] = {
            id: items[idx],
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    },
  );
  await Promise.all(runners);
  return results;
}

async function bulkAction(ids, action, mismatchReason) {
  const cfg = BULK_ACTIONS[action];
  if (!cfg) throw new Error(`unknown action: ${action}`);
  let worker;
  if (action === "reject") worker = (id) => rejectCandidate(id, mismatchReason);
  else if (action === "delete") worker = (id) => deleteCandidate(id);
  else worker = async (id) => {
    const candidate = await updateCandidate(id, { status: cfg.status });
    await recordDecision(candidate, action, mismatchReason);
    return { candidate };
  };
  return runParallel(ids, cfg.concurrency, worker);
}

// ---------- HTTP server ----------

const VALID_STATUS = new Set([
  "Not started", "Intro Call", "Assignment", "Tech Round",
  "Pair Programming Round", "Team Round", "Offer", "Rejected", "Declined", "Hold",
]);

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("invalid JSON body"); }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const { pathname } = url;
    const method = req.method;

    // Static
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = (await readFile(join(__dirname, "hiring-triage.html"), "utf8"))
        .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(POSITION)} Triage</title>`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // List (by Status; default "Not started", e.g. ?status=Hold for Maybe candidates)
    if (method === "GET" && pathname === "/api/candidates") {
      const status = url.searchParams.get("status") || "Not started";
      if (!VALID_STATUS.has(status)) return json(res, 400, { error: "invalid status" });
      const candidates = await listCandidates(status);
      return json(res, 200, { candidates });
    }

    // Bulk action (parallel)
    if (method === "POST" && pathname === "/api/candidates/bulk") {
      const body = await readJson(req);
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return json(res, 400, { error: "ids must be a non-empty array" });
      }
      if (body.ids.length > 200) {
        return json(res, 400, { error: "too many ids (max 200 per request)" });
      }
      if (!Object.prototype.hasOwnProperty.call(BULK_ACTIONS, body.action)) {
        return json(res, 400, { error: `action must be one of: ${Object.keys(BULK_ACTIONS).join(", ")}` });
      }
      const results = await bulkAction(body.ids, body.action);
      const succeeded = results.filter((r) => r.ok).length;
      return json(res, 200, { action: body.action, succeeded, failed: results.length - succeeded, results });
    }

    // Candidate-scoped paths
    const m = pathname.match(/^\/api\/candidates\/([0-9a-fA-F-]{32,36})(?:\/([\w-]+))?$/);
    if (m) {
      const id = m[1];
      const sub = m[2];

      if (method === "PATCH" && !sub) {
        const body = await readJson(req);
        const patch = {};
        if ("score" in body) {
          if (body.score === null) patch.score = null;
          else if (Number.isFinite(body.score) && body.score >= 1 && body.score <= 10) patch.score = body.score;
          else return json(res, 400, { error: "score must be 1..10 or null" });
        }
        if ("scoreReason" in body) {
          if (typeof body.scoreReason !== "string" || body.scoreReason.length > 2000)
            return json(res, 400, { error: "scoreReason must be string ≤2000 chars" });
          patch.scoreReason = body.scoreReason;
        }
        if ("status" in body) {
          if (!VALID_STATUS.has(body.status)) return json(res, 400, { error: "invalid status" });
          patch.status = body.status;
        }
        if ("email" in body) {
          if (body.email !== null && typeof body.email !== "string") return json(res, 400, { error: "email must be string or null" });
          patch.email = body.email;
        }
        const candidate = await updateCandidate(id, patch);
        return json(res, 200, { candidate });
      }

      if (method === "DELETE" && !sub) {
        await deleteCandidate(id);
        return json(res, 200, { ok: true, id });
      }

      if (method === "POST" && sub === "reject") {
        try {
          const out = await rejectCandidate(id);
          return json(res, 200, out);
        } catch (err) {
          const status = err.statusCode ?? 500;
          return json(res, status, { error: err.message });
        }
      }

      if (method === "GET" && sub === "resume") {
        const signed = await getResumeSignedUrl(id);
        if (!signed) return json(res, 404, { error: "no resume on this candidate" });
        const upstream = await fetch(signed);
        if (!upstream.ok || !upstream.body) {
          return json(res, 502, { error: `resume fetch ${upstream.status}` });
        }
        res.writeHead(200, {
          "Content-Type": upstream.headers.get("content-type") ?? "application/pdf",
          "Content-Disposition": "inline",
          "Cache-Control": "private, max-age=300",
        });
        const reader = upstream.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
        return;
      }

      if (method === "GET" && sub === "preview-reject") {
        const candidate = await getCandidate(id);
        const { subject, body } = rejectionEmail(candidate.name);
        return json(res, 200, { to: candidate.email, subject, body });
      }
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`${POSITION} triage → http://localhost:${PORT}`);
  console.log(`decisions log → ${DECISIONS_FILE}`);
});
