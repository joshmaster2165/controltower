/**
 * A small inline icon set (24×24, 1.75px strokes) so the console has one
 * consistent visual language without an icon-font dependency.
 */
export type IconName =
  | 'map'
  | 'tower'
  | 'bell'
  | 'list'
  | 'chart'
  | 'activity'
  | 'plug'
  | 'cpu'
  | 'key'
  | 'tool'
  | 'play'
  | 'logout'
  | 'chevrons-left'
  | 'chevrons-right'
  | 'search'
  | 'refresh'
  | 'plus'
  | 'download'
  | 'upload'
  | 'shield'
  | 'more'
  | 'external'
  | 'check'
  | 'x';

const PATHS: Record<IconName, string> = {
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
  tower: 'M8 21h8m-6 0 1-9h2l1 9M7 8h10l-1.5 4h-7L7 8Zm5-4v4m-3-2.5 3-1.5 3 1.5',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9m4.3 12a1.9 1.9 0 0 0 3.4 0',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  plug: 'M9 2v6m6-6v6M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v4',
  cpu: 'M7 7h10v10H7zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3',
  key: 'M15.5 7.5a3.5 3.5 0 1 1-3.3 4.7L4 20.4V22h2.5v-2H9v-2.5h2.3l.9-.9a3.5 3.5 0 0 1 3.3-9.1ZM16.5 6.5h.01',
  tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4 2.5-2.5Z',
  play: 'M6 4v16l14-8L6 4Z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
  'chevrons-left': 'M11 17l-5-5 5-5m7 10-5-5 5-5',
  'chevrons-right': 'M13 17l5-5-5-5M6 17l5-5-5-5',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm10 3-4.35-4.35',
  refresh: 'M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2M21 4v5h-5M3 20v-5h5',
  plus: 'M12 5v14M5 12h14',
  download: 'M12 3v12m0 0-4-4m4 4 4-4M4 17v3h16v-3',
  upload: 'M12 21V9m0 0-4 4m4-4 4 4M4 7V4h16v3',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
  more: 'M12 12h.01M19 12h.01M5 12h.01',
  external: 'M14 3h7v7m0-7L10 14M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d={PATHS[name]} />
    </svg>
  );
}
