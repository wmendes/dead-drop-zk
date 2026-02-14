const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("./server");

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

const port = Number(process.env.PORT || 8787);
const server = createServer();

server.listen(port, () => {
  console.log(`dead-drop backend listening on http://localhost:${port}`);
  console.log(
    "Endpoints: GET /, POST /prove/ping, POST /tx/submit, POST /tx/submit-direct, POST /relay/ping/request, GET /relay/ping/next, POST /relay/ping/respond, GET /relay/ping/result, WS /relay/webrtc"
  );
});
