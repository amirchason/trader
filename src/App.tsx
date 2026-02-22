import { useState, useEffect } from 'react';
import { Activity, BarChart2, Terminal, DollarSign, Volume2, VolumeX } from 'lucide-react';
import { useStore } from './store';
import { PriceBar } from './components/PriceBar';
import { MarketGrid } from './components/MarketGrid';
import { CandleChart } from './components/CandleChart';
import { SignalPanel } from './components/SignalPanel';
import { BacktestTab } from './components/BacktestTab';
import { PaperTradingPanel } from './components/PaperTradingPanel';
import { NotificationCenter } from './components/Notification';
import { AgentConsole } from './components/AgentConsole';
import { connectSSE } from './services/api';

type Tab = 'trading' | 'paper' | 'backtest';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('paper');
  const [consoleOpen, setConsoleOpen] = useState(false);
  const { soundMuted, setSoundMuted } = useStore();

  useEffect(() => {
    const disconnect = connectSSE();
    return disconnect;
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      <PriceBar />

      {/* Tab Navigation */}
      <div className="flex items-center gap-1 px-4 pt-3 border-b border-gray-800 bg-gray-950 sticky top-0 z-10">
        {(
          [
            { id: 'trading' as Tab, icon: Activity, label: 'Live Trading' },
            { id: 'paper' as Tab, icon: DollarSign, label: 'Paper Trading' },
            { id: 'backtest' as Tab, icon: BarChart2, label: 'Backtesting' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-t border-b-2 transition-colors -mb-px ${
              activeTab === tab.id
                ? 'text-white border-blue-500 bg-gray-900'
                : 'text-gray-400 border-transparent hover:text-gray-200 hover:bg-gray-900/50'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}

        {/* Right-side controls */}
        <div className="ml-auto flex items-center gap-2">
          {/* Mute toggle */}
          <button
            onClick={() => setSoundMuted(!soundMuted)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border transition-colors ${
              soundMuted
                ? 'text-gray-500 border-gray-700 hover:text-gray-300 hover:border-gray-600'
                : 'text-gray-400 border-gray-700 hover:text-gray-200 hover:border-gray-500'
            }`}
            title={soundMuted ? 'Unmute trade sounds' : 'Mute trade sounds'}
          >
            {soundMuted
              ? <VolumeX className="w-3.5 h-3.5" />
              : <Volume2 className="w-3.5 h-3.5" />}
          </button>

          {/* Agent Console toggle */}
          <button
            onClick={() => setConsoleOpen(o => !o)}
            className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded border transition-colors ${
              consoleOpen
                ? 'text-cyan-300 border-cyan-600 bg-cyan-900/30 hover:bg-cyan-900/50'
                : 'text-gray-400 border-gray-700 hover:text-cyan-300 hover:border-cyan-700 hover:bg-gray-900'
            }`}
            title="Toggle Agent Console"
          >
            <Terminal className="w-3.5 h-3.5" />
            Agent Console
          </button>
        </div>
      </div>

      <main className="flex-1 overflow-y-auto">
        {activeTab === 'trading' && (
          <>
            <div className="grid grid-cols-2 gap-4 p-4">
              <CandleChart />
              <SignalPanel />
            </div>
            <div className="border-t border-gray-800">
              <MarketGrid />
            </div>
          </>
        )}
        {activeTab === 'paper' && <PaperTradingPanel />}
        {activeTab === 'backtest' && <BacktestTab />}
      </main>

      <NotificationCenter />

      {/* Floating Agent Console */}
      {consoleOpen && <AgentConsole onClose={() => setConsoleOpen(false)} />}
    </div>
  );
}
