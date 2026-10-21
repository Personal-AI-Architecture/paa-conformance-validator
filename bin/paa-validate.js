#!/usr/bin/env node

const path = require("node:path");
const { runValidation } = require("../lib/validator.js");

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const target = readArgument("--target");
  const sourceCheckout = readArgument("--source-checkout");
  const commandsOnly = process.argv.includes("--commands-only");
  const contractsOnly = process.argv.includes("--contracts-only");

  if (!target || (commandsOnly && contractsOnly)) {
    console.error(
      "Usage: paa-validate --target <paa.target.json> [--source-checkout <paa checkout>] [--commands-only|--contracts-only]"
    );
    process.exit(2);
  }

  const manifestPath = path.resolve(process.cwd(), target);
  const result = await runValidation({
    manifestPath,
    sourceCheckout: sourceCheckout ? path.resolve(process.cwd(), sourceCheckout) : undefined,
    runContracts: !commandsOnly,
    runCommands: !contractsOnly
  });

  for (const check of result.checks) {
    console.log(`[${check.ok ? "PASS" : "FAIL"}] ${check.name}`);
    if (!check.ok && check.detail) {
      console.error(check.detail);
    }
  }

  if (result.errors.length > 0) {
    console.error("PAA validation failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`PAA validation passed for ${result.target}.`);
}

main().catch((error) => {
  console.error(`PAA validator failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
