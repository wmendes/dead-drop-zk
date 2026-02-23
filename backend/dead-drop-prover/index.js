const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("./server");
const { selfCheckProverArtifacts } = require("./prover");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.resolve(__dirname, "../../.env"));

async function start() {
  const strictSelfCheck = process.env.DEAD_DROP_PROVER_SKIP_SELF_CHECK !== "1";
  if (strictSelfCheck) {
    await selfCheckProverArtifacts();
  } else {
    console.warn("[prover] Skipping startup artifact self-check (DEAD_DROP_PROVER_SKIP_SELF_CHECK=1)");
  }

  const port = Number(process.env.PORT || 8787);
  const server = createServer();

  server.listen(port, () => {
    console.log(`dead-drop backend listening on http://localhost:${port}`);
    console.log(
      "Endpoints: GET /, POST /randomness/session, POST /prove/ping, POST /tx/submit, POST /tx/submit-direct, POST /relay/ping/request, GET /relay/ping/next, POST /relay/ping/respond, GET /relay/ping/result, GET /events/ping, WS /relay/webrtc"
    );
  });
}

start().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  console.error("[prover] Startup failed:", message);
  process.exit(1);
});
