import React, { useEffect, useRef } from 'react';
import type { LogEntry } from '../../shared/types';
import { IconTerminal } from './Icons';

interface LogDrawerProps {
  logs: LogEntry[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
  onCopyAll: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const LogDrawer: React.FC<LogDrawerProps> = ({
  logs,
  open,
  onToggle,
  onClear,
  onCopyAll,
}) => {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs, open]);

  return (
    <div className="log-drawer">
      <div className="log-drawer-header" onClick={onToggle}>
        <div className="row-wrap" style={{ gap: 8 }}>
          <IconTerminal size={14} />
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>实时运行日志</span>
          <span className="badge badge-neutral" style={{ padding: '1px 7px', fontSize: 11 }}>
            {logs.length} 条
          </span>
        </div>
        <div className="row-wrap" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
          {open && (
            <>
              <button className="btn btn-sm btn-ghost" onClick={onCopyAll}>
                复制日志
              </button>
              <button className="btn btn-sm btn-ghost" onClick={onClear}>
                清空
              </button>
            </>
          )}
          <button className="btn btn-sm btn-ghost" onClick={onToggle}>
            {open ? '收起' : '展开'}
          </button>
        </div>
      </div>

      {open && (
        <div className="log-drawer-body" ref={bodyRef}>
          {logs.length === 0 ? (
            <div style={{ color: '#64748b' }}>暂无运行日志...</div>
          ) : (
            logs.map((item) => (
              <div key={item.id} className="log-line">
                <span className="log-time">{formatTime(item.timestamp)}</span>
                <span className="log-src">[{item.source}]</span>
                <span className={`log-msg ${item.level}`}>{item.message}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
