#!/usr/bin/env node

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const entryCandidates = [
  path.join(repoRoot, 'backend', 'src', 'server.js'),
  path.join(repoRoot, 'backend', 'src', 'index.js'),
  path.join(repoRoot, 'backend', 'server.js'),
];

const serverEntry = entryCandidates.find((candidate) => fs.existsSync(candidate));

if (!serverEntry) {
  console.error('[wifi-topology-viewer] Could not locate backend entrypoint.');
  console.error('[wifi-topology-viewer] Tried:');
  for (const candidate of entryCandidates) {
    console.error(`  - ${candidate}`);
  }
  process.exit(1);
}

const child = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('error', (error) => {
  console.error(`[wifi-topology-viewer] Failed to launch backend: ${error.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});
