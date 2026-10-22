const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { runValidation } = require("../lib/validator.js");

const CONTRACTS = {
  "specs/openapi/gateway-api.yaml": `paths:
  /conversations/messages:
  /conversations:
  /conversations/{id}:
  /conversations/{id}/messages:
components:
  schemas:
    SendMessageRequest:
    ConversationList:
    Conversation:
    ClientSSEStream:
`,
  "specs/openapi/gateway-engine.yaml": "/engine/chat:\nEngineRequest:\nRequestMetadata:\nSSEStream:\nX-Actor-ID\nX-Actor-Permissions\n",
  "specs/openapi/model-api.yaml": "/completions:\nCompletionRequest:\nCompletionStream:\n",
  "specs/schemas/configuration.json": JSON.stringify({ type: "object", required: ["memory_root", "provider_adapter", "auth_mode", "tool_sources"] }),
  "specs/schemas/identity.json": JSON.stringify({ type: "object", required: ["id", "type", "display_name", "status", "created"] }),
  "specs/schemas/message.json": JSON.stringify({ type: "object", required: ["role", "content"] }),
  "specs/schemas/policy.json": JSON.stringify({ type: "object", required: ["subject", "resource", "action", "effect"] }),
  "specs/schemas/tool-definition.json": JSON.stringify({ type: "object", required: ["name", "description", "parameters"] })
};

const CURRENT_CONTRACTS = Object.fromEntries(Object.entries(CONTRACTS).map(([relative, content]) => {
  const currentPath = relative.replace(/^specs\//, "contracts/");
  if (relative.endsWith("gateway-engine.yaml")) {
    return [currentPath, "/agent-loop/chat:\nAgentLoopRequest:\nRequestMetadata:\nSSEStream:\nauth_context:\n"];
  }
  return [currentPath, content];
}));
for (const [name, required] of Object.entries({
  "auth-context": ["actor", "authentication_id", "authenticated_at", "correlation_id"],
  "authentication-result": ["authenticated", "reason", "correlation_id"],
  "authorization-request": ["actor_id", "resource", "action", "correlation_id"],
  "authorization-result": ["allowed", "reason", "audit_id", "correlation_id"],
  "approval-request": ["request_id", "tool_name", "summary", "status", "created_at", "expires_at"],
  "approval-decision": ["request_id", "decision", "decided_at"],
  "audit-record": ["id", "occurred_at", "event", "actor_id", "action", "result", "correlation_id"]
})) {
  CURRENT_CONTRACTS[`contracts/schemas/${name}.json`] = JSON.stringify({ type: "object", required });
}
CURRENT_CONTRACTS["contracts/schemas/tool-definition.json"] = JSON.stringify({
  type: "object", required: ["name", "description", "parameters", "source", "visibility"]
});

function writeContractFixture(root, commit = "a".repeat(40), commands = [], contracts = CONTRACTS) {
  for (const [relative, content] of Object.entries(contracts)) {
    for (const prefix of ["vendor/paa-contracts", "."]) {
      const file = path.join(root, prefix, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
  const sha256 = Object.fromEntries(Object.entries(contracts).map(([relative, content]) => [relative, crypto.createHash("sha256").update(content).digest("hex")]));
  fs.writeFileSync(path.join(root, "paa.lock.json"), JSON.stringify({
    repository: "https://github.com/Personal-AI-Architecture/the-architecture.git",
    ref: "main", commit, source_root: "vendor/paa-contracts",
    contract_files: Object.keys(contracts), sha256
  }));
  fs.writeFileSync(path.join(root, "paa.target.json"), JSON.stringify({ name: "fixture", language: "test", commands }));
}

function fixture(commands = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paa-validator-fixture-"));
  writeContractFixture(root, undefined, commands);
  return root;
}

function gitSourceFixture(contracts = CONTRACTS) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "paa-validator-source-"));
  for (const [relative, content] of Object.entries(contracts)) {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", ["-C", source, "config", "user.email", "validator@example.invalid"]);
  execFileSync("git", ["-C", source, "config", "user.name", "PAA Validator Tests"]);
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-qm", "fixture"]);
  return { source, commit: execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
}

test("validator rejects a target without a contract lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paa-validator-"));
  const manifestPath = path.join(root, "paa.target.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ name: "missing-lock", language: "test", commands: [] }));

  const result = await runValidation({ manifestPath, runCommands: false });
  assert.equal(result.errors.some((error) => error.includes("Missing contract lock file")), true);
});

test("validator executes target commands from the manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paa-validator-"));
  const manifestPath = path.join(root, "paa.target.json");
  fs.writeFileSync(path.join(root, "paa.lock.json"), JSON.stringify({}));
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      name: "command-target",
      language: "test",
      commands: [{ name: "portable command", command: "node -e \"process.exit(0)\"" }]
    })
  );

  const result = await runValidation({ manifestPath, runContracts: false });
  assert.deepEqual(result.errors, []);
  assert.equal(result.checks.some((check) => check.name === "target command: portable command" && check.ok), true);
});

test("validator detects contract hash and mirror drift", async () => {
  const root = fixture();
  fs.appendFileSync(path.join(root, "vendor/paa-contracts/specs/schemas/message.json"), "\n");
  const result = await runValidation({ manifestPath: path.join(root, "paa.target.json"), runCommands: false });
  assert.equal(result.errors.some((error) => error.includes("Hash drift in vendored contract")), true);
  assert.equal(result.errors.some((error) => error.includes("Local contract mirror differs")), true);
});

test("validator detects a source mismatch at the locked commit", async () => {
  const { source, commit } = gitSourceFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paa-validator-source-target-"));
  writeContractFixture(root, commit);
  fs.appendFileSync(path.join(root, "vendor/paa-contracts/specs/schemas/message.json"), "\n");
  const result = await runValidation({ manifestPath: path.join(root, "paa.target.json"), sourceCheckout: source, runCommands: false });
  assert.equal(result.errors.some((error) => error.includes("Vendored contract differs from")), true);
});

test("validator rejects a malformed target manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paa-validator-malformed-"));
  fs.writeFileSync(path.join(root, "paa.target.json"), "{not-json");
  const result = await runValidation({ manifestPath: path.join(root, "paa.target.json"), runCommands: false });
  assert.equal(result.errors.some((error) => error.includes("target manifest is not valid JSON")), true);
});

test("validator reports failed target commands", async () => {
  const root = fixture([{ name: "intentional failure", command: "node -e \"process.exit(7)\"" }]);
  const result = await runValidation({ manifestPath: path.join(root, "paa.target.json"), runContracts: false });
  assert.equal(result.errors.some((error) => error.includes("Target command failed: intentional failure (exit 7)")), true);
  assert.equal(result.checks.some((check) => check.name === "target command: intentional failure" && !check.ok), true);
});

test("validator accepts the canonical contract layout at the selected source ref", async () => {
  const { source, commit } = gitSourceFixture(CURRENT_CONTRACTS);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paa-validator-current-target-"));
  writeContractFixture(root, commit, [], CURRENT_CONTRACTS);
  const result = await runValidation({
    manifestPath: path.join(root, "paa.target.json"), sourceCheckout: source,
    sourceRef: "HEAD", runCommands: false
  });
  assert.deepEqual(result.errors, []);
});

test("validator rejects an old pin when the selected source ref has moved contracts", async () => {
  const { source, commit } = gitSourceFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paa-validator-old-target-"));
  writeContractFixture(root, commit);
  for (const relative of Object.keys(CONTRACTS)) fs.rmSync(path.join(source, relative));
  for (const [relative, content] of Object.entries(CURRENT_CONTRACTS)) {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  execFileSync("git", ["-C", source, "add", "-A"]);
  execFileSync("git", ["-C", source, "commit", "-qm", "move contracts"]);
  const result = await runValidation({
    manifestPath: path.join(root, "paa.target.json"), sourceCheckout: source,
    sourceRef: "HEAD", runCommands: false
  });
  assert.equal(result.errors.some((error) => error.includes("Source ref HEAD contract file set differs")), true);
});
