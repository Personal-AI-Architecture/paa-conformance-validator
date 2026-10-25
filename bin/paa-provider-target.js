#!/usr/bin/env node
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
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
  const manifest = JSON.parse(fs.readFileSync(path.resolve(target), 'utf8'));
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
    const liveSwap = Boolean(manifest.live?.preference_path);
    const modelIds = liveSwap ? ['paa-fixture-model-a'] : ['paa-fixture-model-a', 'paa-fixture-model-b'];
    for (const modelId of modelIds) {
      console.log(`Checking configured model ${modelId}`);
      const profiles = Object.fromEntries(['alpha', 'beta'].map(name => [name, {
        base_url: `http://${endpointHost}:${port}/${name}/v1`, api_key_env: 'PAA_MODEL_API_KEY',
        model_context_limits: { 'paa-fixture-model-a': 8192, 'paa-fixture-model-b': 8192 }
      }]));
      const scenarios = [
        { model: 'paa-fixture-model-a', provider: 'alpha', expectedText: 'provider-response-paa-fixture-model-a-alpha' },
        { model: 'paa-fixture-model-b', provider: 'alpha', expectedText: 'provider-response-paa-fixture-model-b-alpha' },
        { model: 'paa-fixture-model-b', provider: 'beta', expectedText: 'provider-response-paa-fixture-model-b-beta' }
      ];
      const child = spawn(process.execPath, command, {
        stdio: 'inherit',
        env: { ...process.env, RUNTIME_PROVIDER_ADAPTER: 'openai-compatible',
          PAA_MODEL_API_BASE_URL: `http://${endpointHost}:${port}${liveSwap ? '/alpha' : ''}/v1`,
          PAA_MODEL_ID: modelId, PAA_MODEL_CONTEXT_LIMIT: '8192',
          PAA_MODEL_API_KEY: 'fake-provider-token', PAA_DEFAULT_PROVIDER: liveSwap ? 'alpha' : 'local',
          ...(liveSwap ? { PAA_MODEL_PROFILES_JSON: JSON.stringify(profiles),
            PAA_LIVE_SWAP_SCENARIOS: JSON.stringify(scenarios) } : {}),
          PAA_LIVE_EXPECT_TEXT: `provider-response-${modelId}${liveSwap ? '-alpha' : ''}` }
      });
      const status = await new Promise(resolve => child.once('exit', resolve));
      if (status !== 0) { process.exitCode = status || 1; break; }
    }
  } finally {
    provider.kill('SIGTERM');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
