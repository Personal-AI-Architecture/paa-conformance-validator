const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const REQUIRED_GATEWAY_PATHS = [
  "/conversations/messages",
  "/conversations",
  "/conversations/{id}",
  "/conversations/{id}/messages"
];

const REQUIRED_SCHEMAS = {
  "specs/schemas/configuration.json": ["memory_root", "provider_adapter", "auth_mode", "tool_sources"],
  "specs/schemas/identity.json": ["id", "type", "display_name", "status", "created"],
  "specs/schemas/message.json": ["role", "content"],
  "specs/schemas/policy.json": ["subject", "resource", "action", "effect"],
  "specs/schemas/tool-definition.json": ["name", "description", "parameters"]
};

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile()) {
        files.push(path.relative(directory, fullPath).split(path.sep).join("/"));
      }
    }
  }
  return files.sort();
}

function readJson(filePath, label, errors) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

function checkContractSource({ targetRoot, lock, sourceCheckout, errors }) {
  if (!sourceCheckout) {
    return;
  }

  if (!fs.existsSync(path.join(sourceCheckout, ".git"))) {
    errors.push(`PAA source checkout is not a Git repository: ${sourceCheckout}`);
    return;
  }

  for (const relativeFile of lock.contract_files ?? []) {
    const vendorPath = path.join(targetRoot, lock.source_root, relativeFile);
    try {
      const sourceBytes = execFileSync("git", ["-C", sourceCheckout, "show", `${lock.commit}:${relativeFile}`]);
      if (!sourceBytes.equals(fs.readFileSync(vendorPath))) {
        errors.push(`Vendored contract differs from ${lock.commit}:${relativeFile}.`);
      }
    } catch (error) {
      errors.push(`Unable to read pinned PAA source ${relativeFile}: ${error.message}`);
    }
  }
}

function checkContracts({ targetRoot, lock, sourceCheckout }) {
  const errors = [];
  const vendorRoot = path.join(targetRoot, lock.source_root || "");
  const mirrorRoot = targetRoot;
  const files = Array.isArray(lock.contract_files) ? lock.contract_files : [];

  if (!/^https:\/\/github\.com\/Personal-AI-Architecture\/the-architecture\.git$/.test(lock.repository || "")) {
    errors.push("paa.lock.json repository must point to the PAA architecture repository.");
  }
  if (lock.ref !== "main") {
    errors.push("paa.lock.json ref must be main.");
  }
  if (!/^[0-9a-f]{40}$/.test(lock.commit || "")) {
    errors.push("paa.lock.json commit must be a full 40-character SHA.");
  }
  if (lock.source_root !== "vendor/paa-contracts") {
    errors.push("paa.lock.json source_root must be vendor/paa-contracts.");
  }

  const actualFiles = listFiles(vendorRoot);
  const expectedFiles = [...files].sort();
  if (actualFiles.join("\n") !== expectedFiles.join("\n")) {
    errors.push(`Vendored contract file set differs from paa.lock.json.`);
  }

  for (const relativeFile of files) {
    const vendorPath = path.join(vendorRoot, relativeFile);
    const mirrorPath = path.join(mirrorRoot, relativeFile);
    if (!fs.existsSync(vendorPath)) {
      errors.push(`Missing vendored contract: ${path.join(lock.source_root, relativeFile)}.`);
      continue;
    }
    if (sha256(vendorPath) !== lock.sha256?.[relativeFile]) {
      errors.push(`Hash drift in vendored contract: ${relativeFile}.`);
    }
    if (!fs.existsSync(mirrorPath)) {
      errors.push(`Missing local contract mirror: ${relativeFile}.`);
    } else if (!fs.readFileSync(vendorPath).equals(fs.readFileSync(mirrorPath))) {
      errors.push(`Local contract mirror differs from vendored source: ${relativeFile}.`);
    }
  }

  const gatewayApiPath = path.join(mirrorRoot, "specs/openapi/gateway-api.yaml");
  const enginePath = path.join(mirrorRoot, "specs/openapi/gateway-engine.yaml");
  const modelPath = path.join(mirrorRoot, "specs/openapi/model-api.yaml");
  const gatewayApi = fs.existsSync(gatewayApiPath) ? fs.readFileSync(gatewayApiPath, "utf8") : "";
  const engine = fs.existsSync(enginePath) ? fs.readFileSync(enginePath, "utf8") : "";
  const model = fs.existsSync(modelPath) ? fs.readFileSync(modelPath, "utf8") : "";

  for (const route of REQUIRED_GATEWAY_PATHS) {
    const escaped = route.replace(/[{}]/g, "\\$&");
    if (!new RegExp(`^  ${escaped}:`, "m").test(gatewayApi)) {
      errors.push(`Gateway API path is missing: ${route}.`);
    }
  }
  if (/^  \/chat:/m.test(gatewayApi) || /conversation_id\}/.test(gatewayApi)) {
    errors.push("Gateway API contains a non-PAA route or path parameter.");
  }
  for (const marker of ["SendMessageRequest", "ConversationList", "Conversation", "ClientSSEStream"]) {
    if (!new RegExp(`^    ${marker}:\\s*$`, "m").test(gatewayApi)) {
      errors.push(`Gateway schema is missing: ${marker}.`);
    }
  }
  for (const marker of ["/engine/chat:", "EngineRequest:", "RequestMetadata:", "SSEStream:", "X-Actor-ID", "X-Actor-Permissions"]) {
    if (!engine.includes(marker)) {
      errors.push(`Gateway-Agent Loop contract is missing: ${marker}.`);
    }
  }
  for (const marker of ["/completions:", "CompletionRequest:", "CompletionStream:"]) {
    if (!model.includes(marker)) {
      errors.push(`Model API contract is missing: ${marker}.`);
    }
  }
  if (/^  \/model\/chat\/completions:/m.test(model)) {
    errors.push("Model API promotes a provider-native route into the PAA contract.");
  }

  for (const [relativeFile, requiredKeys] of Object.entries(REQUIRED_SCHEMAS)) {
    const schemaPath = path.join(mirrorRoot, relativeFile);
    const schema = readJson(schemaPath, relativeFile, errors);
    if (!schema) {
      continue;
    }
    if (schema.type !== "object") {
      errors.push(`${relativeFile} must define an object schema.`);
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of requiredKeys) {
      if (!required.includes(key)) {
        errors.push(`${relativeFile} is missing required field: ${key}.`);
      }
    }
  }

  checkContractSource({ targetRoot, lock, sourceCheckout, errors });
  return errors;
}

function runTargetCommands({ targetRoot, commands }) {
  const errors = [];
  const checks = [];
  for (const entry of commands ?? []) {
    const name = entry.name || entry.command;
    const result = spawnSync(entry.command, {
      cwd: targetRoot,
      shell: true,
      encoding: "utf8",
      env: {
        ...process.env,
        PAA_VALIDATOR_TARGET: targetRoot
      }
    });
    const detail = `${result.stdout || ""}${result.stderr || ""}`.trim();
    const ok = result.status === 0;
    checks.push({ name: `target command: ${name}`, ok, detail: ok ? undefined : detail.slice(-4000) });
    if (!ok) {
      errors.push(`Target command failed: ${name} (exit ${result.status ?? "unknown"}).`);
    }
  }
  return { checks, errors };
}

async function runValidation({ manifestPath, sourceCheckout, runContracts = true, runCommands = true }) {
  const manifestErrors = [];
  const manifest = readJson(manifestPath, "target manifest", manifestErrors);
  if (!manifest) {
    return { target: path.basename(path.dirname(manifestPath)), checks: [], errors: manifestErrors };
  }

  const targetRoot = path.resolve(path.dirname(manifestPath), manifest.root || ".");
  const checks = [];
  const errors = [...manifestErrors];
  const lockLabel = manifest.contracts?.lock_file || "paa.lock.json";
  const lockFile = path.join(targetRoot, lockLabel);
  const lock = fs.existsSync(lockFile) ? readJson(lockFile, lockLabel, errors) : undefined;
  if (!lock) {
    errors.push(`Missing contract lock file: ${path.relative(targetRoot, lockFile)}.`);
  }

  if (runContracts && lock) {
    const contractErrors = checkContracts({ targetRoot, lock, sourceCheckout });
    checks.push({ name: "contract source and schema alignment", ok: contractErrors.length === 0 });
    errors.push(...contractErrors);
  }

  if (runCommands) {
    const commandResult = runTargetCommands({ targetRoot, commands: manifest.commands });
    checks.push(...commandResult.checks);
    errors.push(...commandResult.errors);
  }

  if (runContracts || runCommands) {
    checks.unshift({ name: "target manifest", ok: manifest.name && manifest.language && Array.isArray(manifest.commands) });
    if (!manifest.name) errors.push("Target manifest must define name.");
    if (!manifest.language) errors.push("Target manifest must define language.");
    if (!Array.isArray(manifest.commands)) errors.push("Target manifest must define commands as an array.");
  }

  return {
    target: manifest.name || path.basename(path.dirname(manifestPath)),
    checks,
    errors
  };
}

module.exports = {
  checkContracts,
  runValidation
};
