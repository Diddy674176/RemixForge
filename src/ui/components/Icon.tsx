/**
 * Inline stroke icons, drawn on a 24-unit grid at 1.6 stroke width.
 *
 * Kept in-repo rather than pulled from an icon package: the set is small, it
 * ships no extra bytes over the wire, and everything shares one optical
 * weight so the toolbars read as a single family.
 */
export type IconName =
  | 'play'
  | 'pause'
  | 'stop'
  | 'loop'
  | 'metronome'
  | 'undo'
  | 'redo'
  | 'close'
  | 'chevron'
  | 'download'
  | 'plus'
  | 'minus'
  | 'settings'
  | 'export'
  | 'split'
  | 'copy'
  | 'trash'
  | 'magnet'
  | 'zoomIn'
  | 'zoomOut'
  | 'waveform'
  | 'sliders'
  | 'layers'
  | 'disc'
  | 'folder'
  | 'check'
  | 'alert'
  | 'wand'
  | 'align'
  | 'scissors'
  | 'headphones'
  | 'mute'
  | 'solo'
  | 'grid'
  | 'send'
  | 'search'
  | 'arrowUp'
  | 'arrowDown';

const PATHS: Record<IconName, string> = {
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M9 5v14M15 5v14',
  stop: 'M6.5 6.5h11v11h-11z',
  loop: 'M4 9a5 5 0 015-5h10M19 4l-3-3M19 4l-3 3M20 15a5 5 0 01-5 5H5M5 20l3 3M5 20l3-3',
  metronome: 'M12 3l5 17H7L12 3zM5 20h14M12 3l-4 12',
  undo: 'M4 9h11a5 5 0 010 10h-6M4 9l4-4M4 9l4 4',
  redo: 'M20 9H9a5 5 0 000 10h6M20 9l-4-4M20 9l-4 4',
  close: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 5l7 7-7 7',
  download: 'M12 3v12M12 15l-4.5-4.5M12 15l4.5-4.5M4 20h16',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  settings: 'M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM19.4 13.5l1.5 1.2-1.6 2.8-1.8-.6a6.6 6.6 0 01-1.6.9l-.4 1.9h-3.2l-.4-1.9a6.6 6.6 0 01-1.6-.9l-1.8.6-1.6-2.8 1.5-1.2a6.6 6.6 0 010-1.8L3 10.5l1.6-2.8 1.8.6a6.6 6.6 0 011.6-.9L8.4 5.5h3.2l.4 1.9a6.6 6.6 0 011.6.9l1.8-.6 1.6 2.8-1.5 1.2a6.6 6.6 0 010 1.8z',
  export: 'M12 16V4M12 4L8 8M12 4l4 4M4 14v4a2 2 0 002 2h12a2 2 0 002-2v-4',
  split: 'M12 3v18M7 8L4 12l3 4M17 8l3 4-3 4',
  copy: 'M9 9h10v10a2 2 0 01-2 2H9a2 2 0 01-2-2V9zM5 15V5a2 2 0 012-2h10',
  trash: 'M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
  magnet: 'M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4H6zM6 8h4M14 8h4',
  zoomIn: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4M11 8v6M8 11h6',
  zoomOut: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4M8 11h6',
  waveform: 'M3 12h2l2-6 3 14 3-11 2.5 7L19 12h2',
  sliders: 'M4 7h6M14 7h6M4 17h10M18 17h2M12 4v6M16 14v6',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 14l9 5 9-5',
  disc: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 14.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  check: 'M5 13l4.5 4.5L19 7',
  alert: 'M12 4l9 16H3l9-16zM12 10v4M12 17.2v.1',
  wand: 'M5 19L16 8M14 4l1 2.5L17.5 8 15 9l-1 2.5L13 9l-2.5-1L13 6.5 14 4zM19.5 13l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z',
  align: 'M4 4v16M20 4v16M8 9h8M8 9l-2-2M8 9l-2 2M16 15H8M16 15l2-2M16 15l2 2',
  scissors: 'M6.5 8.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM6.5 20.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM8.3 7.3L20 19M8.3 16.7L20 5',
  headphones: 'M4 15v-3a8 8 0 0116 0v3M4 15a2 2 0 012-2h1v6H6a2 2 0 01-2-2v-2zM20 15a2 2 0 01-2 2h-1v-6h1a2 2 0 012 2v2z',
  mute: 'M11 5L6.5 9H3v6h3.5L11 19V5zM16 9.5l5 5M21 9.5l-5 5',
  solo: 'M12 3v18M7 8v8M17 8v8M3 11v2M21 11v2',
  grid: 'M4 4h16v16H4zM4 10h16M4 15h16M10 4v16M15 4v16',
  send: 'M4 12l16-8-6 16-2.5-6L4 12z',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4.5-4.5',
  arrowUp: 'M12 19V5M12 5l-6 6M12 5l6 6',
  arrowDown: 'M12 5v14M12 19l-6-6M12 19l6-6',
};

/** Icons drawn as solid shapes rather than strokes. */
const FILLED: IconName[] = ['play', 'stop'];

export interface IconProps {
  name: IconName;
  size?: number;
  /** Stroke width before scaling. Lower for large sizes, higher for small. */
  weight?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 16, weight = 1.6, className, style }: IconProps) {
  const filled = FILLED.includes(name);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      style={{ display: 'block', flex: 'none', ...style }}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The app mark: five bars at unequal heights, like a level meter at rest. */
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ display: 'block' }}>
      <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <path d="M3.5 14.5v-5" opacity="0.45" />
        <path d="M8 18.5v-13" opacity="0.7" />
        <path d="M12.5 15.5v-7" />
        <path d="M17 20.5v-17" opacity="0.7" />
        <path d="M21 13.5v-3" opacity="0.45" />
      </g>
    </svg>
  );
}
