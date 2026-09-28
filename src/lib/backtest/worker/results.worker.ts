import { ResultAnalytics } from '../analytics';
import { dispatch } from './dispatch';
import type { WorkerRequest, WorkerResponse } from './protocol';

const MAX_RESULTS = 4;
const results = new Map<string, ResultAnalytics>();

function reply(msg: WorkerResponse) {
  (self as unknown as { postMessage(m: WorkerResponse): void }).postMessage(msg);
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'load') {
      results.delete(req.key);
      results.set(req.key, new ResultAnalytics(req.summary));
      while (results.size > MAX_RESULTS) results.delete(results.keys().next().value as string);
      reply({ id: req.id, ok: true, value: null });
      return;
    }
    if (req.type === 'drop') {
      results.delete(req.key);
      reply({ id: req.id, ok: true, value: null });
      return;
    }
    const a = results.get(req.key);
    if (!a) throw new Error(`unknown result ${req.key}`);
    reply({ id: req.id, ok: true, value: dispatch(a, req.call) });
  } catch (e) {
    reply({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
