import { DataManager } from './backtest/DataManager';
import { JobForm } from './backtest/JobForm';
import { JobList } from './backtest/JobList';
import { ResultsDashboard } from './backtest/ResultsDashboard';

export function BacktestTab() {
  return (
    <div className="p-4 flex flex-col gap-4 max-w-screen-2xl mx-auto">
      {/* Data availability panel */}
      <DataManager />

      {/* Job configuration + queue side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <JobForm />
        <JobList />
      </div>

      {/* Results dashboard */}
      <ResultsDashboard />
    </div>
  );
}
