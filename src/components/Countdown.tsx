import { useState, useEffect } from 'react';

interface CountdownProps {
  epochEnd: number; // Unix seconds
}

export function Countdown({ epochEnd }: CountdownProps) {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    function tick() {
      const now = Math.floor(Date.now() / 1000);
      setRemaining(Math.max(0, epochEnd - now));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [epochEnd]);

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const isUrgent = remaining < 60;
  const isExpired = remaining === 0;

  if (isExpired) {
    return <span className="text-gray-500 text-xs font-mono">Expired</span>;
  }

  return (
    <span className={`font-mono text-sm font-bold tabular-nums ${
      isUrgent ? 'text-red-400 animate-pulse' : 'text-yellow-400'
    }`}>
      ⏱ {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
    </span>
  );
}
