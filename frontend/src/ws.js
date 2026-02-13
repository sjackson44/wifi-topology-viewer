const DEFAULT_WS_URL = 'ws://localhost:8787/ws';

export function connectSnapshotStream({
  url = DEFAULT_WS_URL,
  onSnapshot,
  onStatus,
}) {
  let socket = null;
  let reconnectTimer = null;
  let attempts = 0;
  let closedManually = false;

  const connect = () => {
    if (closedManually) {
      return;
    }

    onStatus?.('connecting');
    socket = new WebSocket(url);

    socket.addEventListener('open', () => {
      attempts = 0;
      onStatus?.('connected');
    });

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'snapshot') {
          onSnapshot?.(payload);
        }
      } catch {
        // Ignore malformed data without breaking stream processing.
      }
    });

    socket.addEventListener('close', () => {
      if (closedManually) {
        onStatus?.('disconnected');
        return;
      }

      onStatus?.('reconnecting');
      attempts += 1;
      const delay = Math.min(10_000, 400 * 2 ** attempts) + Math.floor(Math.random() * 250);
      reconnectTimer = setTimeout(connect, delay);
    });

    socket.addEventListener('error', () => {
      socket?.close();
    });
  };

  connect();

  return {
    close() {
      closedManually = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      socket?.close();
    },
  };
}
