import { useEffect } from 'react';
import { useStore } from '../store';
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react';

export function NotificationCenter() {
  const notifications = useStore((s) => s.notifications);
  const dismiss = useStore((s) => s.dismissNotification);

  // Auto-dismiss oldest notification after 8 seconds
  useEffect(() => {
    if (notifications.length === 0) return;
    const timer = setTimeout(() => {
      dismiss(notifications[0].id);
    }, 8000);
    return () => clearTimeout(timer);
  }, [notifications, dismiss]);

  if (notifications.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {notifications.slice(0, 5).map((n) => (
        <div
          key={n.id}
          className={`flex items-start gap-3 p-4 rounded-lg shadow-xl border text-sm ${
            n.type === 'success'
              ? 'bg-emerald-900/95 border-emerald-700 text-emerald-100'
              : n.type === 'error'
              ? 'bg-red-900/95 border-red-700 text-red-100'
              : 'bg-gray-800/95 border-gray-700 text-gray-100'
          }`}
        >
          {n.type === 'success' ? (
            <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          ) : n.type === 'error' ? (
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          ) : (
            <Info className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
          )}
          <span className="flex-1 leading-relaxed">{n.message}</span>
          <button
            onClick={() => dismiss(n.id)}
            className="text-current opacity-60 hover:opacity-100 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
