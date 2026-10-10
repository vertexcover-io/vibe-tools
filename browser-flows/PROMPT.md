# Prompts

Model: Claude Fable 5.1 (Claude Code).

## Prompt 1

> I want to build a skill that encompasses a chrome extension similar to theo recorder within the computer-use-script skill, basically the skill has two flows -> create new flow/execute existing flow. For new flow -> it opens the extension and the page mentioned in the prompt, user manually does what supposed to be done while speaking, it records what person is saying along with all the actions user is doing including recording variables required for an action / optional popups -> anything that it needs to understand to be able to replicate the same flow again. It converts the flow into something that I can run again with different variables. While running it should use claude in chrome -> but should be able to quickly execute deterministic steps and only when it fails on a step should use intelligence to recover -> and update the script. It should store scripts within the skill and index file to be able to quickly see if particular flow exists during run mode and ask for missing variables.

Decisions taken during the session: replay is injected JS through Claude in Chrome's `javascript_tool` (one call per page chunk) rather than an extension play mode; a `--dry-run` was added. The extension is the Theo recorder (content script, offscreen mic page, background relay) renamed, re-keyed and moved to port 9335.
