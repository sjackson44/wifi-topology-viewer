const API_BASE = 'http://localhost:8787';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `request failed (${response.status})`);
  }

  return data;
}

export function fetchConfig() {
  return request('/config');
}

export function updateConfig(payload) {
  return request('/config', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function fetchRecordStatus() {
  return request('/record/status');
}

export function startRecording(path) {
  return request('/record/start', {
    method: 'POST',
    body: JSON.stringify(path ? { path } : {}),
  });
}

export function stopRecording() {
  return request('/record/stop', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function fetchReplayStatus() {
  return request('/replay/status');
}

export function startReplay({ path, speed, loop }) {
  return request('/replay/start', {
    method: 'POST',
    body: JSON.stringify({ path, speed, loop }),
  });
}

export function stopReplay() {
  return request('/replay/stop', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
