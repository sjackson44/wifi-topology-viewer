import {
  estimateDistanceMetersFromRssi,
  formatDistanceMeters,
} from './distance.js';

const MINIMAL_MODE_STORAGE_KEY = 'wifiTopologyViewer.minimalMode';
const SUBTLE_MOTION_STORAGE_KEY = 'wifiTopologyViewer.subtleMotion';
const LIST_ROOM_STORAGE_KEY = 'wifiTopologyViewer.listRoom';

const LIST_ROOM_MIN = 30;
const LIST_ROOM_MAX = 80;
const LIST_ROOM_DEFAULT = 62;
const DENSITY_BAR_WIDTH = 8;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function truncate(text, maxLength = 22) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function buildSignalBars(rssi) {
  const normalized = clamp((rssi + 90) / 60, 0, 1);
  return Math.max(0, Math.min(5, Math.round(normalized * 5)));
}

function clusterColor(clusterId) {
  if (!clusterId || clusterId < 1) {
    return '#57ff9f';
  }

  const offset = ((clusterId * 12) % 34) - 17;
  const hue = 140 + offset;
  return `hsl(${hue} 78% 64%)`;
}

function resolveBand(ap) {
  const text = String(ap.band || '').toLowerCase();
  if (text.includes('2.4')) {
    return '2.4';
  }
  if (text.includes('5')) {
    return '5';
  }

  const channel = Number.parseInt(ap.channel, 10);
  if (!Number.isFinite(channel)) {
    return null;
  }
  if (channel >= 1 && channel <= 14) {
    return '2.4';
  }
  if (channel >= 32) {
    return '5';
  }

  return null;
}

function buildChannelDensity(aps) {
  const channel24 = new Map();
  const channel5 = new Map();

  for (const ap of aps) {
    const channel = Number.parseInt(ap.channel, 10);
    if (!Number.isFinite(channel) || channel <= 0) {
      continue;
    }

    const band = resolveBand(ap);
    if (band === '2.4') {
      channel24.set(channel, (channel24.get(channel) || 0) + 1);
    } else if (band === '5') {
      channel5.set(channel, (channel5.get(channel) || 0) + 1);
    }
  }

  const toRows = (map) =>
    [...map.entries()]
      .map(([channel, count]) => ({ channel, count }))
      .sort((a, b) => a.channel - b.channel);

  return {
    band24: toRows(channel24),
    band5: toRows(channel5),
  };
}

function buildDensityBar(count, maxCount) {
  const safeMax = Math.max(1, maxCount);
  const units = clamp(Math.round((count / safeMax) * DENSITY_BAR_WIDTH), 1, DENSITY_BAR_WIDTH);
  return `${'#'.repeat(units)}${'.'.repeat(DENSITY_BAR_WIDTH - units)}`;
}

function formatStability(value) {
  if (!Number.isFinite(value)) {
    return '--';
  }
  return value.toFixed(2);
}

function buildReportFilename(now = new Date()) {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `wifi-topology-report-${yyyy}${mm}${dd}-${hh}${min}${ss}.md`;
}

function downloadMarkdownFile(markdown, filename) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export function createHud(container, handlers = {}) {
  container.innerHTML = `
    <div class="hud">
      <header class="hud-header">
        <div class="hud-title-row">
          <h1>Wi-Fi Topology Viewer</h1>
          <button
            type="button"
            class="hud-collapse-btn"
            data-role="collapse-toggle"
            aria-label="Collapse sidebar"
            aria-expanded="true"
            title="Collapse sidebar"
          >
            <span class="hamburger-icon" aria-hidden="true"></span>
          </button>
        </div>
        <p data-role="status">connecting</p>
      </header>

      <section class="hud-meta">
        <p data-role="counts">0 APs</p>
        <p data-role="scan">scan n/a</p>
        <p data-role="clusters">clusters n/a</p>
      </section>

      <div class="hud-body" data-role="hud-body">
        <section class="hud-controls">
          <h2>Visual</h2>
          <label class="checkbox-label minimal-mode-toggle">
            <input data-role="minimal-mode" type="checkbox" />Minimal mode
          </label>
          <p class="control-hint">Hide edges + grid + coverage spheres</p>
          <label class="checkbox-label subtle-motion-toggle">
            <input data-role="subtle-motion" type="checkbox" />Subtle motion
          </label>
          <p class="control-hint">Add small drifting motion to nodes</p>

          <h2>Runtime</h2>
          <div class="control-grid">
            <label>scan ms<input data-role="scan-interval" type="number" min="300" max="10000" step="100" /></label>
            <label>window<input data-role="window-size" type="number" min="8" max="240" step="1" /></label>
            <label>edge threshold<input data-role="edge-threshold" type="number" min="0.05" max="0.98" step="0.01" /></label>
            <label>min overlap<input data-role="min-overlap" type="number" min="4" max="80" step="1" /></label>
          </div>
          <button data-role="apply-config" class="control-btn">apply config</button>

          <h2>Capture</h2>
          <label>record path<input data-role="record-path" type="text" placeholder="recordings/session.ndjson" /></label>
          <button data-role="record-toggle" class="control-btn">start recording</button>

          <h2>Replay</h2>
          <label>replay file<input data-role="replay-path" type="text" placeholder="recordings/session.ndjson" /></label>
          <div class="control-grid replay-grid">
            <label>speed<input data-role="replay-speed" type="number" min="0.2" max="8" step="0.1" value="1" /></label>
            <label class="checkbox-label"><input data-role="replay-loop" type="checkbox" />loop</label>
          </div>
          <button data-role="replay-toggle" class="control-btn">start replay</button>
          <button data-role="export-report" class="control-btn">export report</button>

          <div class="list-room-control">
            <div class="list-room-header">
              <span>list room</span>
              <span data-role="list-room-value">${LIST_ROOM_DEFAULT}%</span>
            </div>
            <input
              data-role="list-room"
              class="list-room-input"
              type="range"
              min="${LIST_ROOM_MIN}"
              max="${LIST_ROOM_MAX}"
              step="1"
              value="${LIST_ROOM_DEFAULT}"
              aria-label="Adjust network list space"
            />
          </div>

          <section class="channel-density" data-role="channel-density">
            <h2>Channel density</h2>
            <div class="channel-density-band">
              <p class="channel-density-title">2.4GHz</p>
              <ul data-role="channel-density-24" class="channel-density-list"></ul>
            </div>
            <div class="channel-density-band">
              <p class="channel-density-title">5GHz</p>
              <ul data-role="channel-density-5" class="channel-density-list"></ul>
            </div>
          </section>

          <p data-role="control-msg" class="control-msg">ready</p>
        </section>

        <ul class="network-list" data-role="network-list"></ul>
      </div>
    </div>
  `;

  const statusEl = container.querySelector('[data-role="status"]');
  const hudEl = container.querySelector('.hud');
  const hudBodyEl = container.querySelector('[data-role="hud-body"]');
  const collapseToggleBtn = container.querySelector('[data-role="collapse-toggle"]');
  const countsEl = container.querySelector('[data-role="counts"]');
  const scanEl = container.querySelector('[data-role="scan"]');
  const clustersEl = container.querySelector('[data-role="clusters"]');
  const networkListEl = container.querySelector('[data-role="network-list"]');

  const controlMessageEl = container.querySelector('[data-role="control-msg"]');
  const minimalModeInput = container.querySelector('[data-role="minimal-mode"]');
  const subtleMotionInput = container.querySelector('[data-role="subtle-motion"]');
  const listRoomInput = container.querySelector('[data-role="list-room"]');
  const listRoomValueEl = container.querySelector('[data-role="list-room-value"]');
  const scanIntervalInput = container.querySelector('[data-role="scan-interval"]');
  const windowSizeInput = container.querySelector('[data-role="window-size"]');
  const edgeThresholdInput = container.querySelector('[data-role="edge-threshold"]');
  const minOverlapInput = container.querySelector('[data-role="min-overlap"]');
  const applyConfigBtn = container.querySelector('[data-role="apply-config"]');

  const recordPathInput = container.querySelector('[data-role="record-path"]');
  const recordToggleBtn = container.querySelector('[data-role="record-toggle"]');

  const replayPathInput = container.querySelector('[data-role="replay-path"]');
  const replaySpeedInput = container.querySelector('[data-role="replay-speed"]');
  const replayLoopInput = container.querySelector('[data-role="replay-loop"]');
  const replayToggleBtn = container.querySelector('[data-role="replay-toggle"]');
  const exportReportBtn = container.querySelector('[data-role="export-report"]');

  const channelDensity24El = container.querySelector('[data-role="channel-density-24"]');
  const channelDensity5El = container.querySelector('[data-role="channel-density-5"]');

  let recordingEnabled = false;
  let replayEnabled = false;
  let collapsed = true;
  let visualSettings = {
    minimalMode: loadBooleanPreference(MINIMAL_MODE_STORAGE_KEY, false),
    subtleMotion: loadBooleanPreference(SUBTLE_MOTION_STORAGE_KEY, true),
  };
  let listRoomPercent = loadNumberPreference(
    LIST_ROOM_STORAGE_KEY,
    LIST_ROOM_DEFAULT,
    LIST_ROOM_MIN,
    LIST_ROOM_MAX,
  );
  let selectedBssid = null;
  let lastSnapshot = null;

  function setConnection(status) {
    statusEl.textContent = status;
    statusEl.className = `status status-${status}`;
  }

  function setControlMessage(message, isError = false) {
    controlMessageEl.textContent = message;
    controlMessageEl.className = isError ? 'control-msg error' : 'control-msg';
  }

  function setCollapsed(nextCollapsed) {
    collapsed = Boolean(nextCollapsed);
    hudEl.classList.toggle('hud-collapsed', collapsed);
    container.classList.toggle('hud-root-collapsed', collapsed);

    const isExpanded = !collapsed;
    collapseToggleBtn.setAttribute('aria-expanded', String(isExpanded));
    collapseToggleBtn.setAttribute('aria-label', isExpanded ? 'Collapse sidebar' : 'Expand sidebar');
    collapseToggleBtn.setAttribute('title', isExpanded ? 'Collapse sidebar' : 'Expand sidebar');
  }

  function setVisualSettings(nextSettings = {}, { persist = true, emit = true } = {}) {
    visualSettings = {
      ...visualSettings,
      ...nextSettings,
      minimalMode: Boolean((nextSettings.minimalMode ?? visualSettings.minimalMode)),
      subtleMotion: Boolean((nextSettings.subtleMotion ?? visualSettings.subtleMotion)),
    };

    minimalModeInput.checked = visualSettings.minimalMode;
    subtleMotionInput.checked = visualSettings.subtleMotion;

    if (persist) {
      saveBooleanPreference(MINIMAL_MODE_STORAGE_KEY, visualSettings.minimalMode);
      saveBooleanPreference(SUBTLE_MOTION_STORAGE_KEY, visualSettings.subtleMotion);
    }

    if (emit) {
      handlers.onVisualSettingsChange?.({ ...visualSettings });
    }
  }

  function setListRoomPercent(nextValue, { persist = true } = {}) {
    const numeric = Number.parseInt(nextValue, 10);
    const clampedPercent = clamp(
      Number.isFinite(numeric) ? numeric : LIST_ROOM_DEFAULT,
      LIST_ROOM_MIN,
      LIST_ROOM_MAX,
    );

    listRoomPercent = clampedPercent;
    listRoomInput.value = String(clampedPercent);
    listRoomValueEl.textContent = `${clampedPercent}%`;

    const listFlex = clampedPercent;
    const controlsFlex = 100 - clampedPercent;

    hudBodyEl.style.setProperty('--list-flex', String(listFlex));
    hudBodyEl.style.setProperty('--controls-flex', String(controlsFlex));

    if (persist) {
      saveNumberPreference(LIST_ROOM_STORAGE_KEY, clampedPercent);
    }
  }

  function renderChannelDensity(snapshotAps) {
    const density = buildChannelDensity(snapshotAps);

    const renderBand = (targetEl, rows) => {
      if (!rows.length) {
        const empty = document.createElement('li');
        empty.className = 'channel-density-row empty';
        empty.textContent = '(no data)';
        targetEl.replaceChildren(empty);
        return;
      }

      const maxCount = Math.max(...rows.map((row) => row.count), 1);
      const items = rows.map((row) => {
        const li = document.createElement('li');
        li.className = 'channel-density-row';
        li.textContent = `ch ${row.channel} ${buildDensityBar(row.count, maxCount)} (${row.count})`;
        return li;
      });
      targetEl.replaceChildren(...items);
    };

    renderBand(channelDensity24El, density.band24);
    renderBand(channelDensity5El, density.band5);
  }

  function handleCollapseToggle() {
    setCollapsed(!collapsed);
  }

  function handleMinimalModeChange() {
    setVisualSettings({ minimalMode: minimalModeInput.checked });
  }

  function handleSubtleMotionChange() {
    setVisualSettings({ subtleMotion: subtleMotionInput.checked });
  }

  function handleListRoomInput() {
    setListRoomPercent(listRoomInput.value);
  }

  async function handleExportReport() {
    exportReportBtn.disabled = true;

    try {
      const payload = await handlers.exportReport?.();
      if (!payload?.markdown) {
        throw new Error('report export returned no markdown');
      }

      downloadMarkdownFile(payload.markdown, payload.filename || buildReportFilename());
      setControlMessage('report exported');
    } catch (error) {
      setControlMessage(error.message || 'report export failed', true);
    } finally {
      exportReportBtn.disabled = false;
    }
  }

  function setSelectedBssid(bssid) {
    selectedBssid = bssid || null;
    if (lastSnapshot) {
      update(lastSnapshot);
    }
  }

  function setConfig(config) {
    if (!config) {
      return;
    }

    scanIntervalInput.value = String(config.scanIntervalMs ?? 1000);
    windowSizeInput.value = String(config.windowSize ?? 30);
    edgeThresholdInput.value = String(config.edgeThreshold ?? 0.6);
    minOverlapInput.value = String(config.minOverlap ?? 8);
  }

  function setRecording(status) {
    recordingEnabled = Boolean(status?.enabled);
    recordToggleBtn.textContent = recordingEnabled ? 'stop recording' : 'start recording';
    if (status?.path) {
      recordPathInput.value = status.path;
    }
  }

  function setReplay(status) {
    replayEnabled = Boolean(status?.active);
    replayToggleBtn.textContent = replayEnabled ? 'stop replay' : 'start replay';
    if (status?.path) {
      replayPathInput.value = status.path;
    }
    if (status?.speed) {
      replaySpeedInput.value = String(status.speed);
    }
    replayLoopInput.checked = Boolean(status?.loop);
  }

  async function handleApplyConfig() {
    applyConfigBtn.disabled = true;
    try {
      const payload = {
        scanIntervalMs: Number.parseInt(scanIntervalInput.value, 10),
        windowSize: Number.parseInt(windowSizeInput.value, 10),
        edgeThreshold: Number.parseFloat(edgeThresholdInput.value),
        minOverlap: Number.parseInt(minOverlapInput.value, 10),
      };

      const next = await handlers.applyConfig?.(payload);
      setConfig(next);
      setControlMessage('config updated');
    } catch (error) {
      setControlMessage(error.message || 'config update failed', true);
    } finally {
      applyConfigBtn.disabled = false;
    }
  }

  async function handleRecordToggle() {
    recordToggleBtn.disabled = true;

    try {
      const status = recordingEnabled
        ? await handlers.stopRecording?.()
        : await handlers.startRecording?.(recordPathInput.value.trim());
      setRecording(status);
      setControlMessage(recordingEnabled ? 'recording enabled' : 'recording disabled');
    } catch (error) {
      setControlMessage(error.message || 'recording action failed', true);
    } finally {
      recordToggleBtn.disabled = false;
    }
  }

  async function handleReplayToggle() {
    replayToggleBtn.disabled = true;

    try {
      const status = replayEnabled
        ? await handlers.stopReplay?.()
        : await handlers.startReplay?.({
            path: replayPathInput.value.trim(),
            speed: Number.parseFloat(replaySpeedInput.value),
            loop: replayLoopInput.checked,
          });
      setReplay(status);
      setControlMessage(replayEnabled ? 'replay started' : 'replay stopped');
    } catch (error) {
      setControlMessage(error.message || 'replay action failed', true);
    } finally {
      replayToggleBtn.disabled = false;
    }
  }

  applyConfigBtn.addEventListener('click', handleApplyConfig);
  recordToggleBtn.addEventListener('click', handleRecordToggle);
  replayToggleBtn.addEventListener('click', handleReplayToggle);
  exportReportBtn.addEventListener('click', handleExportReport);
  collapseToggleBtn.addEventListener('click', handleCollapseToggle);
  minimalModeInput.addEventListener('change', handleMinimalModeChange);
  subtleMotionInput.addEventListener('change', handleSubtleMotionChange);
  listRoomInput.addEventListener('input', handleListRoomInput);

  setCollapsed(true);
  setListRoomPercent(listRoomPercent, { persist: true });
  setVisualSettings({}, { persist: true, emit: true });
  renderChannelDensity([]);

  function update(snapshot) {
    lastSnapshot = snapshot;
    const aps = [...(snapshot.aps ?? [])].sort((a, b) => b.rssi - a.rssi);
    const visible = aps.slice(0, 22);

    if (selectedBssid && !visible.some((ap) => ap.bssid === selectedBssid)) {
      const selectedAp = aps.find((ap) => ap.bssid === selectedBssid);
      if (selectedAp) {
        if (visible.length >= 22) {
          visible.pop();
        }
        visible.push(selectedAp);
      }
    }

    countsEl.textContent = `${aps.length} APs tracked • mode ${snapshot.meta?.mode || 'live'}`;

    const scanSource = snapshot.meta?.scanSource ?? 'unknown';
    const scanIntervalMs = snapshot.meta?.scanIntervalMs ?? 'n/a';
    const edgeThreshold = snapshot.meta?.edgeThreshold ?? 'n/a';
    scanEl.textContent = `scan ${scanIntervalMs}ms • ${scanSource} • edge>${edgeThreshold}`;

    const clusterSizes = snapshot.meta?.clusterSizes || [];
    clustersEl.textContent = clusterSizes.length
      ? `clusters ${clusterSizes.join(' / ')}`
      : 'clusters none';

    if (snapshot.meta?.recording !== undefined) {
      recordingEnabled = Boolean(snapshot.meta.recording);
      recordToggleBtn.textContent = recordingEnabled ? 'stop recording' : 'start recording';
    }

    if (snapshot.meta?.replay !== undefined) {
      replayEnabled = Boolean(snapshot.meta.replay);
      replayToggleBtn.textContent = replayEnabled ? 'stop replay' : 'start replay';
    }

    renderChannelDensity(aps);

    const rows = [];
    for (const ap of visible) {
      const row = document.createElement('li');
      row.className = 'network-row';
      row.dataset.bssid = ap.bssid;
      if (selectedBssid && ap.bssid === selectedBssid) {
        row.classList.add('is-selected');
      }
      row.style.setProperty('--cluster-color', clusterColor(ap.clusterId));

      const left = document.createElement('div');
      left.className = 'network-main';

      const ssid = document.createElement('p');
      ssid.className = 'network-ssid';
      ssid.textContent = truncate(ap.ssid || '<hidden>');

      const meta = document.createElement('p');
      meta.className = 'network-meta';
      const clusterText = ap.clusterId ? `C${ap.clusterId} (${ap.clusterSize})` : 'solo';
      meta.textContent = `${clusterText} • ch ${ap.channel || '?'} • ${ap.band || 'unknown'} • ${ap.security || 'UNKNOWN'}`;

      left.appendChild(ssid);
      left.appendChild(meta);

      const right = document.createElement('div');
      right.className = 'network-right';

      const rssi = document.createElement('p');
      rssi.className = 'network-rssi';
      const estimatedDistance = estimateDistanceMetersFromRssi(ap.rssi);
      const distanceLabel = formatDistanceMeters(estimatedDistance);
      rssi.textContent = ap.rssiEstimated
        ? `~${ap.rssi} dBm • ${distanceLabel}`
        : `${ap.rssi} dBm • ${distanceLabel}`;

      const bars = document.createElement('div');
      bars.className = 'signal-bars';
      const activeBars = buildSignalBars(ap.rssi);

      for (let i = 0; i < 5; i += 1) {
        const bar = document.createElement('span');
        bar.className = i < activeBars ? 'sig-bar active' : 'sig-bar';
        bars.appendChild(bar);
      }

      const stability = document.createElement('p');
      stability.className = 'network-stability';
      stability.textContent = `S: ${formatStability(ap.stability)}`;

      right.appendChild(rssi);
      right.appendChild(bars);
      right.appendChild(stability);

      row.appendChild(left);
      row.appendChild(right);
      rows.push(row);
    }

    networkListEl.replaceChildren(...rows);
  }

  return {
    setConnection,
    setConfig,
    setRecording,
    setReplay,
    setSelectedBssid,
    setControlMessage,
    update,
  };
}

function loadBooleanPreference(key, defaultValue = false) {
  try {
    const value = localStorage.getItem(key);
    if (value == null) {
      return defaultValue;
    }
    return value === 'true';
  } catch {
    return defaultValue;
  }
}

function saveBooleanPreference(key, value) {
  try {
    localStorage.setItem(key, String(Boolean(value)));
  } catch {
    // Ignore local storage errors.
  }
}

function loadNumberPreference(key, defaultValue, min, max) {
  try {
    const value = localStorage.getItem(key);
    if (value == null) {
      return defaultValue;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return defaultValue;
    }
    return clamp(parsed, min, max);
  } catch {
    return defaultValue;
  }
}

function saveNumberPreference(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Ignore local storage errors.
  }
}
