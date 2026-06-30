// AI-generated. See PROMPT.md for the prompts and model used.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, "index.html");
const clientEntry = resolve(here, "../../../packages/client/src/index.ts");

const bundleClient = async (): Promise<string> => {
  const result = await build({
    entryPoints: [clientEntry],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const out = result.outputFiles[0];
  if (!out) throw new Error("esbuild produced no output");
  return out.text;
};

const start = async (): Promise<void> => {
  const port = Number(process.env.PORT ?? 5173);
  const clientJs = await bundleClient();

  const server = createServer(async (req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      const html = await readFile(htmlPath, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.url === "/client.js") {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(clientJs);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.listen(port, () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`agentwire-web dev server: ${url}`);
    console.log(`Bundled @agentwire/client (${clientJs.length} bytes) at ${url}/client.js`);
    console.log(`Open the page, set the server base URL + bearer token, then Connect.`);
    console.log(`Hint: start the server with SERVER_BEARER_TOKENS=devtoken npm run serve (default port 8787).`);
  });
};

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
