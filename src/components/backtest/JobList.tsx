import { useEffect } from 'react';
import { Circle, CheckCircle, XCircle, Clock, Trash2, Eye } from 'lucide-react';
import { useStore } from '../../store';
import { fetchBacktestJobs, deleteBacktestJob } from '../../services/api';

const STATUS_CONFIG = {
  pending: { icon: Clock, color: 'text-yellow-400', label: 'Pending' },
  running: { icon: Circle, color: 'text-blue-400', label: 'Running' },
  completed: { icon: CheckCircle, color: 'text-emerald-400', label: 'Done' },
  failed: { icon: XCircle, color: 'text-red-400', label: 'Failed' },
};

export function JobList() {
  const jobs = useStore((s) => s.backtestJobs);
  const selectedJobId = useStore((s) => s.selectedJobId);
  const setSelectedJobId = useStore((s) => s.setSelectedJobId);
  const setBacktestJobs = useStore((s) => s.setBacktestJobs);

  useEffect(() => {
    fetchBacktestJobs()
      .then((jobs) => setBacktestJobs(jobs))
      .catch(() => {});
  }, []);

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await deleteBacktestJob(id);
      const updated = await fetchBacktestJobs();
      setBacktestJobs(updated);
    } catch {
      // ignore
    }
  }

  const runningCount = jobs.filter((j) => j.status === 'running').length;
  const pendingCount = jobs.filter((j) => j.status === 'pending').length;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
          Job Queue
          {runningCount > 0 && (
            <span className="px-1.5 py-0.5 bg-blue-600 text-white text-xs rounded animate-pulse">
              {runningCount} running
            </span>
          )}
          {pendingCount > 0 && (
            <span className="px-1.5 py-0.5 bg-yellow-700 text-yellow-200 text-xs rounded">
              {pendingCount} pending
            </span>
          )}
        </h3>
        <span className="text-xs text-gray-600">{jobs.length} total</span>
      </div>

      {jobs.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-xs py-8">
          No backtest jobs yet — configure and run one!
        </div>
      ) : (
        <div className="flex flex-col gap-2 overflow-y-auto max-h-72 pr-1">
          {jobs.map((job) => {
            const cfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.pending;
            const Icon = cfg.icon;
            const isSelected = job.id === selectedJobId;
            const coinStr = job.config.coins?.join(', ') || '—';
            const tfStr = job.config.timeframes?.join(', ') || '—';

            return (
              <div
                key={job.id}
                onClick={() => setSelectedJobId(job.id)}
                className={`flex items-center gap-3 p-3 rounded cursor-pointer border transition-all ${
                  isSelected
                    ? 'bg-blue-900/30 border-blue-700'
                    : 'bg-gray-800/40 border-gray-700/50 hover:border-gray-600'
                }`}
              >
                <Icon
                  className={`w-4 h-4 shrink-0 ${cfg.color} ${job.status === 'running' ? 'animate-pulse' : ''}`}
                />

                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-gray-200 truncate">
                    {coinStr} × {tfStr}
                  </div>
                  <div className="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                    <span className={cfg.color}>{cfg.label}</span>
                    {job.status === 'running' && (
                      <span className="font-mono text-blue-300">{job.progress}%</span>
                    )}
                    {job.summary && job.status === 'completed' && (
                      <>
                        <span className="text-emerald-400 font-mono">
                          WR: {(job.summary.winRate * 100).toFixed(1)}%
                        </span>
                        <span className={`font-mono ${job.summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {job.summary.totalPnl >= 0 ? '+' : ''}${job.summary.totalPnl.toFixed(2)}
                        </span>
                      </>
                    )}
                  </div>

                  {job.status === 'running' && (
                    <div className="mt-1.5 w-full bg-gray-700 rounded-full h-1">
                      <div
                        className="bg-blue-500 h-1 rounded-full transition-all duration-500"
                        style={{ width: `${job.progress}%` }}
                      />
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {job.status === 'completed' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setSelectedJobId(job.id); }}
                      className="p-1 text-gray-400 hover:text-blue-400 transition-colors"
                      title="View results"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {job.status !== 'running' && (
                    <button
                      onClick={(e) => handleDelete(job.id, e)}
                      className="p-1 text-gray-600 hover:text-red-400 transition-colors"
                      title="Delete job"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
