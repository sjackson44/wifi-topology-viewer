#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildMarkdownReport,
  formatAnalyzeSummary,
} from '../backend/src/insights.js';
import { runAnalyzeSession } from '../backend/src/analyze.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

try {
  await main();
} catch (error) {
  process.stderr.write(`${error?.message || 'command failed'}\n`);
  process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  if (parsed.help) {
    printUsage();
    return;
  }

  if (!parsed.analyze) {
    await import('../backend/src/server.js');
    return;
  }

  await runAnalyzeCommand(parsed);
}

async function runAnalyzeCommand(options) {
  let serverProcess = null;

  if (!options.noServer) {
    serverProcess = spawn(process.execPath, [join(projectRoot, 'backend', 'src', 'server.js')], {
      cwd: projectRoot,
      stdio: 'ignore',
      detached: false,
      env: {
        ...process.env,
        // Avoid duplicate rapid scans when analyze mode is already polling.
        SCAN_INTERVAL_MS: process.env.SCAN_INTERVAL_MS || '5000',
      },
    });
  }

  try {
    const durationSec = parsePositiveInt(options.duration, 120, '--duration');
    const scanIntervalMs = parsePositiveInt(options.scanInterval, 1000, '--scan-interval');

    const result = await runAnalyzeSession({
      durationSec,
      scanIntervalMs,
      scanTimeoutMs: parsePositiveInt(process.env.SCAN_TIMEOUT_MS, 5000, 'SCAN_TIMEOUT_MS'),
      windowSize: parsePositiveInt(process.env.WINDOW_SIZE, 30, 'WINDOW_SIZE'),
      evictAfterMs: parsePositiveInt(process.env.EVICT_AFTER_MS, 30_000, 'EVICT_AFTER_MS'),
      maxAps: parsePositiveInt(process.env.MAX_APS, 40, 'MAX_APS'),
      minOverlap: parsePositiveInt(process.env.MIN_OVERLAP, 8, 'MIN_OVERLAP'),
      edgeThreshold: parsePositiveFloat(process.env.EDGE_THRESHOLD, 0.6, 'EDGE_THRESHOLD'),
      maxEdges: parsePositiveInt(process.env.MAX_EDGES, 120, 'MAX_EDGES'),
    });

    const outputPath = resolveOutputPath(options.out, options.json ? 'json' : 'md');

    if (options.json) {
      const jsonText = JSON.stringify(result.summary, null, 2);
      process.stdout.write(`${jsonText}\n`);
      await writeOutputFile(outputPath, jsonText);
      process.stderr.write(`[analyze] wrote ${outputPath}\n`);
    } else {
      const summaryText = formatAnalyzeSummary(result.summary);
      const markdown = buildMarkdownReport({ summary: result.summary });
      process.stdout.write(`${summaryText}\n`);
      await writeOutputFile(outputPath, markdown);
      process.stderr.write(`[analyze] wrote ${outputPath}\n`);
    }

    process.exitCode = 0;
  } catch (error) {
    const exitCode = Number.isFinite(error?.exitCode) ? error.exitCode : 1;
    process.stderr.write(`[analyze] ${error?.message || 'failed'}\n`);
    process.exitCode = exitCode;
  } finally {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  }
}

function parseArgs(argv) {
  const options = {
    analyze: false,
    duration: '120',
    json: false,
    out: '',
    noServer: false,
    scanInterval: '1000',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--analyze') {
      options.analyze = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--no-server') {
      options.noServer = true;
      continue;
    }

    if (arg === '--duration') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--duration requires a value (seconds)');
      }
      options.duration = next;
      i += 1;
      continue;
    }

    if (arg === '--out') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--out requires a file path');
      }
      options.out = next;
      i += 1;
      continue;
    }

    if (arg === '--scan-interval') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--scan-interval requires a value (ms)');
      }
      options.scanInterval = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePositiveInt(value, fallback, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  if (label.startsWith('--')) {
    throw new Error(`${label} must be a positive integer`);
  }

  return fallback;
}

function parsePositiveFloat(value, fallback, label) {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  if (label.startsWith('--')) {
    throw new Error(`${label} must be a positive number`);
  }

  return fallback;
}

function resolveOutputPath(pathInput, extension) {
  if (pathInput && pathInput.trim()) {
    return isAbsolute(pathInput) ? pathInput : resolve(process.cwd(), pathInput.trim());
  }

  const stamp = timestampForFile();
  return resolve(process.cwd(), `wifi-topology-report-${stamp}.${extension}`);
}

function timestampForFile(now = new Date()) {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

async function writeOutputFile(targetPath, contents) {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, contents, 'utf8');
}

function printUsage() {
  process.stdout.write('wifi-topology-viewer\n\n');
  process.stdout.write('Usage:\n');
  process.stdout.write('  wifi-topology-viewer\n');
  process.stdout.write('  wifi-topology-viewer --analyze --duration 120 [--json] [--out <path>] [--no-server] [--scan-interval <ms>]\n');
}
