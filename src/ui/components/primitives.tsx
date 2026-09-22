import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export function formatTime(seconds: number, withMs = false): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return withMs
    ? `${m}:${rest.toFixed(2).padStart(5, '0')}`
    : `${m}:${Math.floor(rest).toString().padStart(2, '0')}`;
}

export function formatBars(seconds: number, bpm: number, meter: number): string {
  const beat = 60 / bpm;
  const totalBeats = seconds / beat;
  const bar = Math.floor(totalBeats / meter) + 1;
  const beatInBar = Math.floor(totalBeats % meter) + 1;
  return `${bar}.${beatInBar}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export function gainToDb(gain: number): string {
  if (gain <= 0.0001) return '-inf';
  const db = 20 * Math.log10(gain);
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
}

interface PanelProps {
  title: string;
  count?: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Panel({ title, count, actions, defaultOpen = true, children }: PanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="panel">
      <header onClick={() => setOpen((o) => !o)}>
        <span className={`chev ${open ? 'open' : ''}`} aria-hidden>
          ›
        </span>
        <span>{title}</span>
        {count !== undefined && <span className="count">{count}</span>}
        <span className="spacer" />
        <span onClick={(e) => e.stopPropagation()}>{actions}</span>
      </header>
      {open && <div className="body">{children}</div>}
    </section>
  );
}

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** Logarithmic response — right for frequencies and times. */
  log?: boolean;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  /** Called on release, to commit one history entry per gesture. */
  onCommit?: (v: number) => void;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  unit,
  log,
  format,
  onChange,
  onCommit,
}: SliderProps) {
  const toSlider = (v: number) =>
    log ? Math.log(Math.max(v, min || 1e-4)) : v;
  const fromSlider = (v: number) => (log ? Math.exp(v) : v);
  const sMin = toSlider(min || 1e-4);
  const sMax = toSlider(max);
  const sStep = log ? (sMax - sMin) / 400 : step;

  return (
    <div className="slider">
      <label>{label}</label>
      <span className="value">
        {format ? format(value) : value.toFixed(step >= 1 ? 0 : 2)}
        {unit ? ` ${unit}` : ''}
      </span>
      <input
        type="range"
        min={sMin}
        max={sMax}
        step={sStep}
        value={toSlider(value)}
        onChange={(e) => onChange(fromSlider(Number(e.target.value)))}
        onPointerUp={(e) => onCommit?.(fromSlider(Number((e.target as HTMLInputElement).value)))}
        onKeyUp={(e) => onCommit?.(fromSlider(Number((e.target as HTMLInputElement).value)))}
        aria-label={label}
      />
    </div>
  );
}

/** Level meter driven by a polling callback rather than React state churn. */
export function Meter({ read }: { read: () => number }) {
  const ref = useRef<HTMLElement>(null);
  const peakRef = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const level = read();
      // Fast attack, slow release, so the meter is readable.
      peakRef.current = level > peakRef.current ? level : peakRef.current * 0.9;
      if (ref.current) {
        const pct = Math.min(100, Math.sqrt(peakRef.current) * 100);
        ref.current.style.height = `${pct}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [read]);

  return (
    <div className="meter" aria-hidden>
      <i ref={ref} style={{ height: '0%' }} />
    </div>
  );
}

interface ModalProps {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  width?: number;
}

export function Modal({ title, onClose, footer, children, width }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog" aria-label={title}>
        <header>
          <span className="grow">{title}</span>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'ok' | 'error';
}

let toastId = 0;
const toastListeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];

export function notify(message: string, tone: Toast['tone'] = 'info'): void {
  const toast: Toast = { id: ++toastId, message, tone };
  toasts = [...toasts, toast];
  for (const fn of toastListeners) fn(toasts);
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== toast.id);
    for (const fn of toastListeners) fn(toasts);
  }, tone === 'error' ? 9000 : 4500);
}

export function Toasts() {
  const [items, setItems] = useState<Toast[]>(toasts);
  useEffect(() => {
    toastListeners.add(setItems);
    return () => {
      toastListeners.delete(setItems);
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

export function Spinner() {
  return <span className="spin" aria-hidden />;
}

/** Drag helper: reports pointer deltas until release. */
export function useDrag(
  onMove: (dx: number, dy: number, e: PointerEvent) => void,
  onEnd?: () => void,
) {
  return useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const move = (ev: PointerEvent) => onMove(ev.clientX - startX, ev.clientY - startY, ev);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        onEnd?.();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [onMove, onEnd],
  );
}
