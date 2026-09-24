// Tick driver. Timers inside a dedicated worker are not throttled in hidden Chrome tabs (unlike
// main-thread setTimeout chains, which drop to one wake-up per minute), and the worker's messages reach
// the page on a queue that is not throttled either. Falls back to setInterval if workers are unavailable.

const WORKER_SRC = 'let id=0;onmessage=e=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}';

let url: string | null = null;
function workerUrl(): string {
  url ??= URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  return url;
}

export class Ticker {
  private worker: Worker | null = null;
  private fallbackId: ReturnType<typeof setInterval> | null = null;
  private period = 0;
  private onTick: () => void;

  constructor(onTick: () => void) {
    this.onTick = onTick;
    try {
      this.worker = new Worker(workerUrl());
      this.worker.onmessage = () => this.onTick();
    } catch {
      this.worker = null;
    }
  }

  get usesWorker(): boolean {
    return this.worker !== null;
  }

  setPeriod(ms: number): void {
    if (ms === this.period) return;
    this.period = ms;
    if (this.worker) {
      this.worker.postMessage(ms);
      return;
    }
    if (this.fallbackId !== null) clearInterval(this.fallbackId);
    this.fallbackId = ms > 0 ? setInterval(() => this.onTick(), ms) : null;
  }

  stop(): void {
    this.setPeriod(0);
    this.worker?.terminate();
    this.worker = null;
  }
}
