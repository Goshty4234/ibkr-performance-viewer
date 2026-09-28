'use client';

import type { ResultSummary } from '@/lib/engine/types';
import type { ResultAnalytics } from '../analytics';
import type { AnalyticsCall, WorkerRequest, WorkerResponse } from './protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * Runs result analytics off the main thread. Each result summary is posted
 * once per key; later calls only send the small request. Falls back to the
 * main thread when workers are unavailable.
 */
class AnalyticsClient {
  private worker: Worker | null = null;
  private broken = false;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private loaded = new Map<string, Promise<void>>();
  private summaries = new WeakMap<ResultSummary, string>();
  private local = new Map<string, Promise<ResultAnalytics>>();

  private getWorker(): Worker | null {
    if (this.broken || typeof window === 'undefined' || typeof Worker === 'undefined') return null;
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL('./results.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error));
      };
      this.worker.onerror = (ev) => {
        ev.preventDefault?.();
        this.fail(new Error(ev.message || 'Analytics worker crashed'));
      };
    } catch {
      this.broken = true;
      this.worker = null;
    }
    return this.worker;
  }

  private fail(err: Error) {
    this.broken = true;
    this.worker?.terminate();
    this.worker = null;
    this.loaded.clear();
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private post(msg: WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never): Promise<unknown> {
    const w = this.getWorker();
    if (!w) return Promise.reject(new Error('no worker'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ ...msg, id } as WorkerRequest);
    });
  }

  private async localAnalytics(key: string, summary: ResultSummary): Promise<ResultAnalytics> {
    let p = this.local.get(key);
    if (!p) {
      p = import('../analytics').then((m) => new m.ResultAnalytics(summary));
      this.local.set(key, p);
      while (this.local.size > 2) this.local.delete(this.local.keys().next().value as string);
    }
    return p;
  }

  private ensure(key: string, summary: ResultSummary): Promise<void> {
    if (this.summaries.get(summary) !== key) {
      this.summaries.set(summary, key);
      this.loaded.delete(key);
    }
    let p = this.loaded.get(key);
    if (!p) {
      p = this.post({ type: 'load', key, summary }).then(() => undefined);
      this.loaded.set(key, p);
      p.catch(() => this.loaded.delete(key));
    }
    return p;
  }

  async call<T>(key: string, summary: ResultSummary, call: AnalyticsCall): Promise<T> {
    if (this.getWorker()) {
      try {
        await this.ensure(key, summary);
        return (await this.post({ type: 'call', key, call })) as T;
      } catch (e) {
        if (!this.broken) throw e;
      }
    }
    const a = await this.localAnalytics(key, summary);
    const { dispatch } = await import('./dispatch');
    return dispatch(a, call) as T;
  }
}

let client: AnalyticsClient | null = null;

export function analyticsClient(): AnalyticsClient {
  if (!client) client = new AnalyticsClient();
  return client;
}
