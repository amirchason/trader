import { workerData, parentPort } from 'worker_threads';
import { queryCandles } from './db';
import { runBacktestForPair, aggregateResults, type BacktestConfig, type BacktestEvent } from './backtestEngine';

interface WorkerInput {
  jobId: string;
  config: BacktestConfig;
}

async function main() {
  const { jobId, config } = workerData as WorkerInput;

  if (!parentPort) throw new Error('No parentPort — must run as worker thread');

  const pairs: { coin: string; timeframe: string }[] = [];
  for (const coin of config.coins) {
    for (const timeframe of config.timeframes) {
      pairs.push({ coin, timeframe });
    }
  }

  const allTrades: any[] = [];
  let processedPairs = 0;

  // Load MTF candles once per coin if mtf_reversion mode is requested
  const needsMTF = config.signalModes.includes('mtf_reversion');
  const mtfCandleCache: Record<string, BacktestConfig['mtfCandles']> = {};

  for (const { coin, timeframe } of pairs) {
    const dbCandles = queryCandles(coin, timeframe, config.fromMs, config.toMs);

    if (dbCandles.length === 0) {
      processedPairs++;
      parentPort.postMessage({
        jobId,
        event: {
          type: 'progress',
          processed: processedPairs,
          total: pairs.length,
          percent: Math.round((processedPairs / pairs.length) * 100),
        },
      });
      continue;
    }

    // Load MTF context candles once per coin (cached across timeframes)
    let configWithMTF = config;
    if (needsMTF) {
      if (!mtfCandleCache[coin]) {
        const extraMs = 30 * 24 * 3600000; // 30-day warmup period
        mtfCandleCache[coin] = {
          candles1h: queryCandles(coin, '1h', config.fromMs - extraMs, config.toMs),
          candles4h: queryCandles(coin, '4h', config.fromMs - extraMs, config.toMs),
        };
      }
      configWithMTF = { ...config, mtfCandles: mtfCandleCache[coin] };
    }

    const pairTrades = runBacktestForPair(
      dbCandles,
      coin,
      timeframe,
      configWithMTF,
      (event: BacktestEvent) => {
        parentPort!.postMessage({ jobId, event });
      },
    );

    allTrades.push(...pairTrades);
    processedPairs++;

    parentPort.postMessage({
      jobId,
      event: {
        type: 'progress',
        processed: processedPairs,
        total: pairs.length,
        percent: Math.round((processedPairs / pairs.length) * 100),
      },
    });
  }

  const result = aggregateResults(allTrades, config);
  parentPort.postMessage({ jobId, event: { type: 'complete', result } });
}

main().catch((err) => {
  parentPort?.postMessage({
    jobId: (workerData as WorkerInput)?.jobId,
    event: { type: 'error', error: String(err) },
  });
});
