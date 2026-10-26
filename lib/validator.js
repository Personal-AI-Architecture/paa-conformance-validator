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

const CURRENT_REQUIRED_SCHEMAS = {
  ...Object.fromEntries(Object.entries(REQUIRED_SCHEMAS).map(([file, required]) => [file.replace(/^specs\//, "contracts/"), required])),
  "contracts/schemas/auth-context.json": ["actor", "authentication_id", "authenticated_at", "correlation_id"],
  "contracts/schemas/authentication-result.json": ["authenticated", "reason", "correlation_id"],
  "contracts/schemas/authorization-request.json": ["actor_id", "resource", "action", "correlation_id"],
  "contracts/schemas/authorization-result.json": ["allowed", "reason", "audit_id", "correlation_id"],
  "contracts/schemas/approval-request.json": ["request_id", "tool_name", "summary", "status", "created_at", "expires_at"],
  "contracts/schemas/approval-decision.json": ["request_id", "decision", "decided_at"],
  "contracts/schemas/audit-record.json": ["id", "occurred_at", "event", "actor_id", "action", "result", "correlation_id"]
};
CURRENT_REQUIRED_SCHEMAS["contracts/schemas/tool-definition.json"] = ["name", "description", "parameters", "source", "visibility"];

function contractLayout(files, errors) {
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string")) {
    errors.push("paa.lock.json contract_files must be a nonempty array of paths.");
    return undefined;
  }
  const prefix = files.every((file) => file.startsWith("contracts/")) ? "contracts"
    : files.every((file) => file.startsWith("specs/")) ? "specs" : undefined;
  if (!prefix) {
    errors.push("paa.lock.json contract_files must use only specs/ or only contracts/ paths.");
  }
  if (new Set(files).size !== files.length) {
    errors.push("paa.lock.json contract_files contains duplicate paths.");
  }
  return prefix;
}

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

function checkContractSource({ targetRoot, lock, sourceCheckout, sourceRef, layout, errors }) {
  if (!sourceCheckout) {
    if (sourceRef) errors.push("--source-ref requires --source-checkout.");
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

  if (!sourceRef || !layout) return;
  try {
    const sourceFiles = execFileSync("git", ["-C", sourceCheckout, "ls-tree", "-r", "--name-only", sourceRef, "--", `${layout}/openapi`, `${layout}/schemas`], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean).sort();
    const lockedFiles = [...lock.contract_files].sort();
    if (sourceFiles.join("\n") !== lockedFiles.join("\n")) {
      errors.push(`Source ref ${sourceRef} contract file set differs from the pinned template. Re-pin before claiming current PAA alignment.`);
      return;
    }
    for (const relativeFile of lockedFiles) {
      const sourceBytes = execFileSync("git", ["-C", sourceCheckout, "show", `${sourceRef}:${relativeFile}`]);
      if (!sourceBytes.equals(fs.readFileSync(path.join(targetRoot, lock.source_root, relativeFile)))) {
        errors.push(`Pinned template contract differs from ${sourceRef}:${relativeFile}.`);
      }
    }
  } catch (error) {
    errors.push(`Unable to check PAA source ref ${sourceRef}: ${error.message}`);
  }
}

function checkContracts({ targetRoot, lock, sourceCheckout, sourceRef }) {
  const errors = [];
  const vendorRoot = path.join(targetRoot, lock.source_root || "");
  const mirrorRoot = targetRoot;
  const files = Array.isArray(lock.contract_files) ? lock.contract_files : [];
  const layout = contractLayout(lock.contract_files, errors);

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

  const gatewayApiPath = path.join(mirrorRoot, `${layout}/openapi/gateway-api.yaml`);
  const agentLoopPath = path.join(mirrorRoot, `${layout}/openapi/gateway-agent-loop.yaml`);
  const modelPath = path.join(mirrorRoot, `${layout}/openapi/model-api.yaml`);
  const gatewayApi = fs.existsSync(gatewayApiPath) ? fs.readFileSync(gatewayApiPath, "utf8") : "";
  const agentLoop = fs.existsSync(agentLoopPath) ? fs.readFileSync(agentLoopPath, "utf8") : "";
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
  const agentLoopMarkers = layout === "contracts"
    ? ["/agent-loop/chat:", "AgentLoopRequest:", "RequestMetadata:", "SSEStream:", "auth_context:"]
    : ["/agent-loop/chat:", "AgentLoopRequest:", "RequestMetadata:", "SSEStream:", "X-Actor-ID", "X-Actor-Permissions"];
  for (const marker of agentLoopMarkers) {
    if (!agentLoop.includes(marker)) {
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

  const schemas = layout === "contracts" ? CURRENT_REQUIRED_SCHEMAS : REQUIRED_SCHEMAS;
  for (const [relativeFile, requiredKeys] of Object.entries(schemas)) {
    if (!files.includes(relativeFile)) {
      errors.push(`Contract lock is missing required schema: ${relativeFile}.`);
    }
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

  checkContractSource({ targetRoot, lock, sourceCheckout, sourceRef, layout, errors });
  return errors;
}

function runTargetCommands({ targetRoot, commands, commandImage }) {
  const errors = [];
  const checks = [];
  for (const entry of commands ?? []) {
    const name = entry.name || entry.command;
    const result = commandImage
      ? spawnSync("docker", [
          "run", "--rm",
          ...(typeof process.getuid === "function" ? ["--user", `${process.getuid()}:${process.getgid()}`] : []),
          "-e", "HOME=/tmp", "-e", "MAVEN_CONFIG=/tmp/.m2", "-e", "JAVA_TOOL_OPTIONS=-Duser.home=/tmp", "-e", "GOCACHE=/tmp/paa-go-cache",
          "-e", "PAA_VALIDATOR_TARGET=/work",
          "-v", `${targetRoot}:/work`, "-w", "/work",
          commandImage, "sh", "-c", entry.command
        ], { encoding: "utf8" })
      : spawnSync(entry.command, {
          cwd: targetRoot,
          shell: true,
          encoding: "utf8",
          env: { ...process.env, PAA_VALIDATOR_TARGET: targetRoot }
        });
    const detail = `${result.stdout || ""}${result.stderr || ""}${result.error ? `\n${result.error.message}` : ""}`.trim();
    const ok = result.status === 0;
    checks.push({ name: `target command: ${name}`, ok, detail: ok ? undefined : detail.slice(-4000) });
    if (!ok) {
      errors.push(`Target command failed: ${name} (exit ${result.status ?? "unknown"}).`);
    }
  }
  return { checks, errors };
}

async function runValidation({ manifestPath, sourceCheckout, sourceRef, commandImage, runContracts = true, runCommands = true }) {
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
    const contractErrors = checkContracts({ targetRoot, lock, sourceCheckout, sourceRef });
    checks.push({ name: "contract source and schema alignment", ok: contractErrors.length === 0 });
    errors.push(...contractErrors);
  }

  if (runCommands) {
    const commandResult = runTargetCommands({ targetRoot, commands: manifest.commands, commandImage });
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
