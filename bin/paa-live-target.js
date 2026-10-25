#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { runLiveChecks, runSwapChecks } = require('../lib/live.js');

const args = process.argv.slice(2);
const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined;
const dockerImage = args.includes('--docker-image') ? args[args.indexOf('--docker-image') + 1] : undefined;
if (!target) { console.error('Usage: paa-live-target --target <paa.target.json>'); process.exit(2); }

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const manifestPath = path.resolve(target);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.live?.start || typeof manifest.live.start !== 'string') throw new Error('Target manifest lacks live.start command.');
  const root = path.dirname(manifestPath);
  const port = await unusedPort();
  const key = crypto.randomBytes(24).toString('hex');
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paa-live-target-'));
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paa-live-auth-'));
  const containerName = `paa-live-${port}-${process.pid}`;
  const env = { ...process.env, PAA_HOST: dockerImage ? '0.0.0.0' : '127.0.0.1',
    PAA_PORT: String(port), PAA_DEMO_API_KEY: key, RUNTIME_MEMORY_ROOT: memoryRoot,
    PAA_AUTH_STATE_ROOT: authRoot };
  const dockerArgs = dockerImage ? [
    'run', '--rm', '--name', containerName, '-p', `127.0.0.1:${port}:${port}`,
    '--add-host', 'host.docker.internal:host-gateway',
    ...(typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : []),
    '-e', 'HOME=/tmp', '-e', 'MAVEN_CONFIG=/tmp/.m2', '-e', 'JAVA_TOOL_OPTIONS=-Duser.home=/tmp',
    '-e', 'GOCACHE=/tmp/paa-go-cache', '-e', `PAA_HOST=0.0.0.0`, '-e', `PAA_PORT=${port}`,
    '-e', `PAA_DEMO_API_KEY=${key}`, '-e', 'RUNTIME_MEMORY_ROOT=/paa-memory',
    '-e', 'PAA_AUTH_STATE_ROOT=/paa-auth',
    ...['RUNTIME_PROVIDER_ADAPTER', 'PAA_MODEL_API_BASE_URL', 'PAA_MODEL_ID', 'PAA_MODEL_CONTEXT_LIMIT', 'PAA_MODEL_API_KEY',
      'PAA_MODEL_PROFILES_JSON', 'PAA_DEFAULT_PROVIDER']
      .filter(name => process.env[name]).flatMap(name => ['-e', name]),
    '-v', `${root}:/work`, '-v', `${memoryRoot}:/paa-memory`, '-v', `${authRoot}:/paa-auth`, '-w', '/work', dockerImage, 'sh', '-c', manifest.live.start
  ] : [];
  let output = '';
  let child;
  function launch() {
    output = '';
    child = dockerImage
      ? spawn('docker', dockerArgs, { cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(manifest.live.start, { cwd: root, shell: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'], env });
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
  }
  async function stop() {
    if (dockerImage) {
      try { execFileSync('docker', ['stop', '--time', '1', containerName], { stdio: 'ignore', timeout: 5000 }); } catch {}
    }
    if (child && child.exitCode === null) {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {}
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    }
  }
  async function waitReady(baseUrl) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (child.exitCode !== null) break;
      try { const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(300) });
        if (response.status === 200) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Starter did not become ready. ${output}`);
  }
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    launch();
    await waitReady(baseUrl);
    const result = await runLiveChecks({ baseUrl, apiKey: key });
    for (const check of result.checks) console.log(`[${check.ok ? 'PASS' : 'FAIL'}] ${check.name}${check.detail ? `: ${check.detail}` : ''}`);
    if (result.errors.length) process.exitCode = 1;
    if (manifest.live.preference_path && process.env.PAA_LIVE_SWAP_SCENARIOS) {
      const scenarios = JSON.parse(process.env.PAA_LIVE_SWAP_SCENARIOS);
      const swap = await runSwapChecks({ baseUrl, apiKey: key,
        preferencePath: manifest.live.preference_path, scenarios });
      for (const check of swap.checks) console.log(`[${check.ok ? 'PASS' : 'FAIL'}] ${check.name}${check.detail ? `: ${check.detail}` : ''}`);
      if (swap.errors.length) process.exitCode = 1;
    }
    if (result.conversationId) {
      await stop();
      const files = [];
      function collect(directory) {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
          const full = path.join(directory, item.name);
          if (item.isDirectory()) collect(full);
          else if (item.isFile()) files.push(full);
        }
      }
      collect(memoryRoot);
      const readable = files.some(file => fs.readFileSync(file, 'utf8').includes(result.conversationId));
      console.log(`[${readable ? 'PASS' : 'FAIL'}] owner can read conversation files while server is stopped`);
      if (!readable) process.exitCode = 1;
      const secretFree = files.every(file => !fs.readFileSync(file, 'utf8').includes(key));
      console.log(`[${secretFree ? 'PASS' : 'FAIL'}] owner Memory files do not contain the Gateway token`);
      if (!secretFree) process.exitCode = 1;
      launch();
      await waitReady(baseUrl);
      const response = await fetch(`${baseUrl}/conversations/${encodeURIComponent(result.conversationId)}`, { headers: { 'X-API-Key': key } });
      const detail = response.status === 200 ? await response.json() : {};
      const ok = response.status === 200 && Array.isArray(detail.messages) && detail.messages.length >= 2;
      console.log(`[${ok ? 'PASS' : 'FAIL'}] conversation survives restart${ok ? '' : `: HTTP ${response.status}`}`);
      if (!ok) process.exitCode = 1;
      if (manifest.live.preference_path && process.env.PAA_LIVE_SWAP_SCENARIOS) {
        const scenarios = JSON.parse(process.env.PAA_LIVE_SWAP_SCENARIOS);
        const expected = scenarios[scenarios.length - 1];
        const saved = await fetch(`${baseUrl}${manifest.live.preference_path}`, { headers: { 'X-API-Key': key } });
        const preference = saved.status === 200 ? await saved.json() : {};
        const kept = preference.model === expected.model && preference.active_provider_profile === expected.provider;
        console.log(`[${kept ? 'PASS' : 'FAIL'}] owner preferences survive restart`);
        if (!kept) process.exitCode = 1;
      }
    }
  } finally {
    await stop();
    fs.rmSync(memoryRoot, { recursive: true, force: true });
    fs.rmSync(authRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
