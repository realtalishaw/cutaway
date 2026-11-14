import type { CSSProperties } from 'react';

const PATHS = {
  record: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  import: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="7" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.4" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
  screen: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
  window: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
  region: '<path d="M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2"/>',
  camera: '<rect x="3" y="6.5" width="13" height="11" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.500c2.600 2.400 3.900 5.200 3.900 8.500s-1.300 6.100-3.900 8.500c-2.600-2.400-3.900-5.200-3.900-8.500s1.300-6.100 3.900-8.500z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3"/>',
  speaker: '<path d="M4 9.5h3l5-4v13l-5-4H4zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/>',
  scissors: '<circle cx="6.5" cy="7" r="2.5"/><circle cx="6.5" cy="17" r="2.5"/><path d="M8.6 8.4L20 18M8.6 15.6L20 6"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M10.5 8v5M8 10.5h5"/>',
  layout: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><rect x="13" y="12" width="6" height="6" rx="1.5" fill="currentColor" stroke="none"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14 4v16"/>',
  text: '<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>',
  broll: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M3 15h18M8 5v4M16 5v4M8 15v4M16 15v4"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 018 0v2.5"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 017.5-2"/>',
  mask: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15l10-6M7 11l5-3M12 16l5-3"/>',
  undo: '<path d="M8 7L4 11l4 4M4 11h10a5.5 5.5 0 010 11h-2"/>',
  redo: '<path d="M16 7l4 4-4 4M20 11H10a5.5 5.5 0 000 11h2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  dots: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  back: '<path d="M14 6l-6 6 6 6"/>',
  sparkle: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.500l5.1-1.9zM18.5 15.500l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" fill="currentColor" stroke="none"/>',
  pencil: '<path d="M4 20l1-4.500L15.500 5a2.100 2.100 0 013 3L8 18.500zM13.500 7l3 3"/>',
  warn: '<path d="M12 4l9 15.500H3zM12 10v4.500M12 17.300v.2"/>',
  info: '<circle cx="12" cy="12" r="8.500"/><path d="M12 11v5.500M12 7.800v.2"/>',
  folder: '<path d="M3.500 7a2 2 0 012-2h4l2 2.500h7a2 2 0 012 2V17a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12.500h8L17 7M10.500 11v5M13.500 11v5"/>',
  gear: '<path d="M12.220 2h-.440a2 2 0 0 0-2 2v.180a2 2 0 0 1-1 1.730l-.430.250a2 2 0 0 1-2 0l-.150-.080a2 2 0 0 0-2.730.730l-.220.380a2 2 0 0 0 .730 2.730l.150.100a2 2 0 0 1 1 1.720v.510a2 2 0 0 1-1 1.740l-.150.090a2 2 0 0 0-.730 2.730l.220.380a2 2 0 0 0 2.730.730l.150-.080a2 2 0 0 1 2 0l.430.250a2 2 0 0 1 1 1.730V20a2 2 0 0 0 2 2h.440a2 2 0 0 0 2-2v-.180a2 2 0 0 1 1-1.730l.430-.250a2 2 0 0 1 2 0l.150.080a2 2 0 0 0 2.730-.730l.220-.390a2 2 0 0 0-.730-2.730l-.150-.080a2 2 0 0 1-1-1.740v-.500a2 2 0 0 1 1-1.740l.150-.090a2 2 0 0 0 .730-2.730l-.220-.380a2 2 0 0 0-2.730-.730l-.150.080a2 2 0 0 1-2 0l-.430-.250a2 2 0 0 1-1-1.730V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  link: '<path d="M10 14a4 4 0 005.700 0l3-3a4 4 0 00-5.700-5.700l-1 1M14 10a4 4 0 00-5.700 0l-3 3A4 4 0 0011 18.700l1-1"/>',
  sync: '<path d="M4.500 12a7.500 7.500 0 0113-5.100L20 9.500M19.500 12a7.500 7.500 0 01-13 5.100L4 14.500M20 4.500v5h-5M4 19.500v-5h5"/>',
  wave: '<path d="M4 12h1.500M8 8v8M11.500 5v14M15 9v6M18.500 11v2M20.500 12H22"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.500" cy="10" r="1.600"/><path d="M4 17l5-4.500 3.500 3 3-2.500 4.500 4"/>',
  chat: '<path d="M4.500 6.500a2.500 2.500 0 0 1 2.500-2.500h10a2.500 2.500 0 0 1 2.500 2.500v7a2.500 2.500 0 0 1-2.500 2.500h-5.200l-4.300 3.500v-3.500h-.500a2.500 2.500 0 0 1-2.500-2.500z"/><path d="M9 9.500h6M9 12.500h3.500"/>',
  eye: '<path d="M2.500 12s3.500-6.500 9.500-6.500 9.500 6.500 9.500 6.500-3.500 6.500-9.500 6.500S2.500 12 2.500 12z"/><circle cx="12" cy="12" r="2.800"/>',
  eyeOff: '<path d="M4 4l16 16M9.900 5.800A9.700 9.700 0 0112 5.500c6 0 9.500 6.500 9.500 6.500a15.500 15.500 0 01-3 3.700M6.300 7.500A15 15 0 002.500 12S6 18.500 12 18.500a9.300 9.300 0 003.700-.8"/>',
  cursor: '<path d="M6 4l12 7-5 1.500L10.500 18z"/>',
  speed: '<path d="M4.500 16a8 8 0 1115 0M12 13l4-4.500"/><circle cx="12" cy="13.500" r="1.300" fill="currentColor" stroke="none"/>',
  captions: '<rect x="3" y="5" width="18" height="14" rx="2.500"/><path d="M7 14.500h4M13 14.500h4M7 11h2.500M11.500 11H17"/>',
  music: '<path d="M9 18V6l10-2v11"/><circle cx="6.500" cy="18" r="2.500"/><circle cx="16.500" cy="15.500" r="2.500"/>',
  copy: '<rect x="8.500" y="8.500" width="11" height="11" rx="2.200"/><path d="M15.500 8.500V6.700a2.200 2.200 0 00-2.200-2.200H6.700a2.200 2.200 0 00-2.200 2.200v6.600a2.200 2.200 0 002.200 2.200h1.800"/>',
  alignLeft: '<path d="M4.500 6h15M4.500 10.500h9M4.500 15h13M4.500 19.500h7"/>',
  alignCenter: '<path d="M4.500 6h15M7.500 10.500h9M5.500 15h13M8.500 19.500h7"/>',
  alignRight: '<path d="M4.500 6h15M10.500 10.500h9M6.500 15h13M12.500 19.500h7"/>',
  bell: '<path d="M6.500 16.500V11a5.500 5.500 0 0111 0v5.500l1.500 1.500H5z"/><path d="M10 20.500a2.200 2.200 0 004 0"/>',
  upload: '<path d="M12 16V5m0 0l-4 4m4-4l4 4M5 19h14"/>',
  history: '<path d="M4.500 12a7.500 7.500 0 107.500-7.500A7.600 7.600 0 006 7.500L4.500 9M4.500 5v4h4M12 8.500V12l2.500 2"/>',
  user: '<circle cx="12" cy="8.500" r="3.500"/><path d="M5 19.500a7 7 0 0114 0"/>',
  palette: '<path d="M12 4a8 8 0 100 16c1.300 0 1.800-1 1.300-2-.600-1.300.2-2.500 1.700-2.500H17a3 3 0 003-3C20 7.500 16.500 4 12 4z"/><circle cx="8.500" cy="10.500" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="15.500" cy="10.500" r="1" fill="currentColor" stroke="none"/>',
  shield: '<path d="M12 3.500l7 2.500v5.500c0 4.500-3 7.500-7 9-4-1.500-7-4.500-7-9V6z"/>',
  expand: '<path d="M8 4H4v4M16 4h4v4M20 16v4h-4M4 16v4h4"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8M11 7H6a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1v-5"/>',
  clock: '<circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 2"/>',
  sidebar: '<rect x="3" y="4.500" width="18" height="15" rx="2.500"/><path d="M15 4.500v15"/><path d="M17.300 8.500h1.400M17.300 11.500h1.400"/>',
  frame: '<rect x="3.500" y="3.500" width="17" height="17" rx="3" stroke-dasharray="3 2.600"/><rect x="7.500" y="7.500" width="9" height="9" rx="1.500" fill="currentColor" stroke="none"/>',
  pointer: '<path d="M6 3.500l12.500 8-5.300 1.300-1.900 5.700z" fill="currentColor" stroke="none"/>',
  command: '<path d="M9 9h6v6H9zM9 9V6.500A2.500 2.500 0 106.500 9zM15 9V6.500A2.500 2.500 0 1117.500 9zM9 15v2.500A2.500 2.500 0 116.500 15zM15 15v2.500a2.500 2.500 0 102.500-2.500z"/>',
  path: '<circle cx="7" cy="5.500" r="2"/><circle cx="17" cy="18.500" r="2"/><path d="M7 7.500c0 6 10 3 10 9"/>',
  skipBack: '<path d="M19 6l-7 6 7 6zM11 6l-7 6 7 6z"/>',
  skipFwd: '<path d="M5 6l7 6-7 6zM13 6l7 6-7 6z"/>',
  playCircle: '<circle cx="12" cy="12" r="9"/><path d="M10 8.500v7l5.500-3.500z" fill="currentColor" stroke="none"/>',
  pauseCircle: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  crop: '<path d="M7 3v14h14M3 7h14v14"/>',
  aspect: '<rect x="3" y="5" width="18" height="14" rx="2.500"/><path d="M3 9h18M12 9v10"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.500"/><path d="M10.500 6h3"/>',
  width: '<path d="M4 12h16M4 12l3-3M4 12l3 3M20 12l-3-3M20 12l-3 3"/>',
  transcript: '<path d="M5 6h14M5 10h14M5 14h9M5 18h6"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  zoomOut: '<circle cx="10.500" cy="10.500" r="6"/><path d="M15 15l5 5M8 10.500h5"/>',
  flag: '<path d="M6 21V4M6 5h11l-2.500 4 2.500 4H6"/>',
  film: '<path d="M5 4h14v16H5zM9 4v16M15 4v16M5 8h4M5 12h4M5 16h4M15 8h4M15 12h4M15 16h4"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, style, className }: { name: IconName; size?: number; style?: CSSProperties; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flex: 'none', ...style }}
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}

/** The mark: two frames, the second cut away at an angle. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden style={{ flex: 'none' }}>
      <rect x="2" y="6" width="17" height="20" rx="4" fill="none" stroke="currentColor" strokeWidth="2.2" opacity="0.55" />
      <path d="M15 6h11a4 4 0 014 4v12a4 4 0 01-4 4H9z" fill="var(--accent)" />
    </svg>
  );
}
