# Prompt log — granola-cli

**Model / agent:** Claude Fable 5 via Claude Code.

## Original prompt

> Build a granola-cli that lets me access the Granola private API (list/search
> sessions, get transcripts) plus a Claude skill that powers this CLI. Hardcode
> the local supabase.json path (`~/Library/Application Support/Granola/supabase.json`)
> in the CLI to read the refresh_token, and use the confirmed refresh flow:
> POST `https://api.granola.ai/v1/refresh-access-token` with `{refresh_token}` to
> mint a fresh access_token, then call endpoints like get-documents,
> get-document-transcript, and search-meetings-turbopuffer with
> `Authorization: Bearer <access_token>`. Build inside vibe-tools.

## Follow-up prompts

> Features to support -> search for call by name, date etc, list all transcripts
> in a project, on a day with attendees etc, get transcript/notes. Basically way
> i will use in claude is find me my conversation with Aman yesterday in Harness
> sync -> it should by default find the call and then let me load either the
> transcript or the notes

> why is search not working? / figure out search

## How it was built

1. Read `supabase.json` structure: tokens live under `workos_tokens` (a JSON
   string) → `refresh_token`. Verified the refresh flow returns `access_token`.
2. Probed the API. Confirmed working endpoints:
   - `v2/get-documents` `{limit, list_id?}` → `docs[]` with `title`, `created_at`,
     `people` (attendees), `google_calendar_event`, `notes_markdown`. `limit:500`
     returns all docs; `list_id` scopes to a folder.
   - `v1/get-document-transcript` `{document_id}` → segments with
     `start_timestamp`, `text`, `detected_speaker_name`/`source`.
   - `v1/get-document-panels` `{document_id}` → AI note panels.
   - `v1/get-document-lists-metadata` `{}` → folders/projects.
3. **Search dead-end:** every payload shape for `search-meetings-turbopuffer`
   returned `400 Bad Request`. Decompiled `Granola.app/Contents/Resources/app.asar`
   — the endpoint is called as `k(e, "search-meetings-turbopuffer", {input: t})`,
   and the AI-tool schemas (`listMeetings`/`fetchMeetings`/`searchMeetingsByKeywords`)
   are client-side; the real turbopuffer body is constructed server-side from an
   embedding pipeline. Concluded search is a server black box and pivoted to
   client-side filtering over `get-documents`, which is exact and supports
   attendee/date/folder filters keyword search can't.
4. Built the CLI around the **find → load** flow the user described, with a `get`
   command that resolves natural filters to the single best match and prints the
   `transcript <id>` / `notes <id>` commands to load it.

## Gotcha

`httpx` transparently decompresses gzip responses but leaves the
`Content-Encoding: gzip` header, so manually calling `gzip.decompress` on the body
double-decompresses and throws `BadGzipFile`. Just use `resp.json()`.
