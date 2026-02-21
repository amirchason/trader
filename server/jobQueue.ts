import { Worker } from 'worker_threads';
import path from 'path';
import os from 'os';
import { getDb } from './db';
import type { BacktestConfig, BacktestResult } from './backtestEngine';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface BacktestJob {
  id: string;
  config: BacktestConfig;
  status: JobStatus;
  progress: number;
  result: BacktestResult | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

type BroadcastFn = (payload: object) => void;
let _broadcast: BroadcastFn = () => {};

export function setBroadcast(fn: BroadcastFn) {
  _broadcast = fn;
}

function generateId(): string {
  return `bt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createJob(config: BacktestConfig): string {
  const db = getDb();
  const id = generateId();

  db.prepare(`
    INSERT INTO backtest_jobs (id, config, status, progress, created_at)
    VALUES (?, ?, 'pending', 0, ?)
  `).run(id, JSON.stringify(config), Date.now());

  scheduleWorker();
  return id;
}

export function getJob(id: string): BacktestJob | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM backtest_jobs WHERE id = ?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    config: JSON.parse(row.config),
    status: row.status,
    progress: row.progress,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function listJobs(): BacktestJob[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM backtest_jobs ORDER BY created_at DESC LIMIT 50').all() as any[];
  return rows.map((row) => ({
    id: row.id,
    config: JSON.parse(row.config),
    status: row.status,
    progress: row.progress,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

export function deleteJob(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM backtest_jobs WHERE id = ? AND status != ?').run(id, 'running');
  return (result.changes as number) > 0;
}

const MAX_CONCURRENT = Math.max(1, Math.min(3, os.cpus().length - 1));
let runningWorkers = 0;

function scheduleWorker() {
  if (runningWorkers >= MAX_CONCURRENT) return;

  const db = getDb();
  const nextJob = db.prepare(`
    SELECT id, config FROM backtest_jobs
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
  `).get() as { id: string; config: string } | undefined;

  if (!nextJob) return;

  db.prepare(`
    UPDATE backtest_jobs SET status = 'running', started_at = ? WHERE id = ?
  `).run(Date.now(), nextJob.id);

  runningWorkers++;

  _broadcast({ type: 'backtest_job_update', data: { jobId: nextJob.id, status: 'running', progress: 0 }, timestamp: Date.now() });

  const workerPath = path.join(__dirname, 'backtestWorker.ts');
  const tsconfigPath = path.join(__dirname, '..', 'tsconfig.server.json');

  const worker = new Worker(workerPath, {
    workerData: { jobId: nextJob.id, config: JSON.parse(nextJob.config) },
    execArgv: ['--require', 'ts-node/register'],
    env: { ...process.env, TS_NODE_PROJECT: tsconfigPath },
  });

  worker.on('message', (msg: { jobId: string; event: any }) => {
    const { jobId, event } = msg;

    if (event.type === 'progress') {
      db.prepare('UPDATE backtest_jobs SET progress = ? WHERE id = ?').run(event.percent, jobId);
      _broadcast({ type: 'backtest_progress', data: { jobId, percent: event.percent }, timestamp: Date.now() });
    }

    if (event.type === 'candle') {
      _broadcast({ type: 'backtest_candle', data: { jobId, candle: event.candle, indicators: event.indicators }, timestamp: Date.now() });
    }

    if (event.type === 'trade') {
      _broadcast({ type: 'backtest_trade', data: { jobId, trade: event.trade }, timestamp: Date.now() });
    }

    if (event.type === 'complete') {
      const resultToStore = {
        ...event.result,
        trades: (event.result.trades as any[]).slice(0, 10_000),
      };

      db.prepare(`
        UPDATE backtest_jobs
        SET status = 'completed', progress = 100, result = ?, completed_at = ?
        WHERE id = ?
      `).run(JSON.stringify(resultToStore), Date.now(), jobId);

      runningWorkers--;
      _broadcast({ type: 'backtest_complete', data: { jobId, result: event.result.summary }, timestamp: Date.now() });
      scheduleWorker();
    }

    if (event.type === 'error') {
      db.prepare(`
        UPDATE backtest_jobs
        SET status = 'failed', error = ?, completed_at = ?
        WHERE id = ?
      `).run(event.error, Date.now(), jobId);

      runningWorkers--;
      _broadcast({ type: 'backtest_job_update', data: { jobId, status: 'failed', error: event.error }, timestamp: Date.now() });
      scheduleWorker();
    }
  });

  worker.on('error', (err) => {
    console.error('[JobQueue] Worker error:', err);
    db.prepare(`UPDATE backtest_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
      .run(String(err), Date.now(), nextJob.id);
    runningWorkers--;
    scheduleWorker();
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[JobQueue] Worker exited with code ${code}`);
    }
  });
}

export function resumePendingJobs() {
  const db = getDb();
  // Reset stuck 'running' jobs from previous server session
  db.prepare(`UPDATE backtest_jobs SET status = 'pending', progress = 0 WHERE status = 'running'`).run();

  const pending = db.prepare(`SELECT COUNT(*) as c FROM backtest_jobs WHERE status = 'pending'`).get() as { c: number };
  for (let i = 0; i < Math.min(pending.c, MAX_CONCURRENT); i++) {
    scheduleWorker();
  }
}
