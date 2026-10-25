#!/usr/bin/env node
const { runLiveChecks } = require('../lib/live.js');
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const baseUrl = args.includes('--url') ? value('--url') : undefined;
const apiKey = args.includes('--api-key') ? value('--api-key') : process.env.PAA_DEMO_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('Usage: paa-live --url <running service> --api-key <test key>');
  process.exit(2);
}
runLiveChecks({ baseUrl, apiKey }).then(result => {
  for (const check of result.checks) {
    console.log(`[${check.ok ? 'PASS' : 'FAIL'}] ${check.name}${check.detail ? `: ${check.detail}` : ''}`);
  }
  process.exitCode = result.errors.length ? 1 : 0;
}).catch(error => { console.error(error); process.exitCode = 1; });
