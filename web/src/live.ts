import type { InfvizEvent } from './events';

/** Open the engine websocket. Resolves with the socket once the first message arrives. */
export function connectLive(
  onEvent: (e: InfvizEvent) => void,
  onClose: () => void,
  timeoutMs = 1500,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch (e) {
      reject(e);
      return;
    }
    const fail = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error('live connection failed'));
    };
    const timer = setTimeout(fail, timeoutMs);
    ws.onmessage = (m) => {
      let ev: InfvizEvent | null = null;
      try {
        ev = JSON.parse(m.data as string);
      } catch {
        return;
      }
      if (!ev || typeof ev.type !== 'string') return;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(ws);
      }
      onEvent(ev);
    };
    ws.onerror = fail;
    ws.onclose = () => {
      if (!settled) fail();
      else onClose();
    };
  });
}

async function post(path: string, body: unknown) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json().catch(() => ({}));
}
export const api = {
  load: (n: number, rate: number) => post('/api/load', { n, rate }),
  speed: (step_delay: number) => post('/api/speed', { step_delay }),
  request: (prompt: string, max_new_tokens?: number) =>
    post('/api/requests', max_new_tokens ? { prompt, max_new_tokens } : { prompt }),
};
