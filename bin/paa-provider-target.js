#!/usr/bin/env node
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined;
const image = args.includes('--docker-image') ? args[args.indexOf('--docker-image') + 1] : undefined;
if (!target) { console.error('Usage: paa-provider-target --target <paa.target.json> [--docker-image <image>]'); process.exit(2); }

async function unusedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const port = await unusedPort();
  const provider = spawn(process.execPath, [path.join(__dirname, '../test/fixtures/openai-provider.js')], {
    env: { ...process.env, PAA_FAKE_HOST: '0.0.0.0', PAA_FAKE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit']
  });
  try {
    await new Promise((resolve, reject) => {
      provider.stdout.once('data', resolve);
      provider.once('exit', code => reject(new Error(`Fake provider exited ${code}`)));
    });
    const endpointHost = image ? 'host.docker.internal' : '127.0.0.1';
    const command = [path.join(__dirname, 'paa-live-target.js'), '--target', target, ...(image ? ['--docker-image', image] : [])];
    for (const modelId of ['paa-fixture-model-a', 'paa-fixture-model-b']) {
      console.log(`Checking configured model ${modelId}`);
      const child = spawn(process.execPath, command, {
        stdio: 'inherit',
        env: { ...process.env, RUNTIME_PROVIDER_ADAPTER: 'openai-compatible',
          PAA_MODEL_API_BASE_URL: `http://${endpointHost}:${port}/v1`,
          PAA_MODEL_ID: modelId, PAA_MODEL_CONTEXT_LIMIT: '8192',
          PAA_MODEL_API_KEY: 'fake-provider-token', PAA_LIVE_EXPECT_TEXT: `provider-response-${modelId}` }
      });
      const status = await new Promise(resolve => child.once('exit', resolve));
      if (status !== 0) { process.exitCode = status || 1; break; }
    }
  } finally {
    provider.kill('SIGTERM');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
