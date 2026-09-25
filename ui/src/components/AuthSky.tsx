import { useEffect, useState } from 'react';

/**
 * The sign-in page's sky: a radar scope around the tower, flights crossing on
 * curved routes with contrails, and one aircraft in a holding pattern — the
 * amber of a flight held for approval on the Airspace. Pure SVG; still for
 * anyone who asks for reduced motion.
 */

// A top-down airliner pointing along +x, so rotate="auto" lines it up with its route.
const PLANE = 'M11 0 C11 -1 9.5 -1.4 8 -1.4 L2.5 -1.4 L-3 -8.5 L-5.2 -8.5 L-2.2 -1.4 L-7.2 -1.4 L-9.3 -4.2 L-10.8 -4.2 L-9.6 0 L-10.8 4.2 L-9.3 4.2 L-7.2 1.4 L-2.2 1.4 L-5.2 8.5 L-3 8.5 L2.5 1.4 L8 1.4 C9.5 1.4 11 1 11 0 Z';

// The tower sits low on the right; routes are drawn in a 600×900 frame that is cropped to fit.
const TOWER = { x: 400, y: 800 };
const ROUTES = [
  { d: 'M-40 210 C 160 150, 330 250, 470 170 S 690 120, 660 60', dur: 23, begin: 0, scale: 1.05 },
  { d: 'M660 520 C 520 560, 430 640, 400 740', dur: 17, begin: 4, scale: 0.9 },
  { d: 'M-60 880 C 120 800, 240 870, 330 830 S 560 700, 680 730', dur: 26, begin: 9, scale: 1 },
  { d: 'M-50 60 C 150 110, 300 40, 420 90 S 600 180, 680 150', dur: 30, begin: 15, scale: 0.8 },
];
// A racetrack holding pattern beside the tower.
const HOLD = `M${TOWER.x - 60} ${TOWER.y - 150} h100 a30 30 0 0 1 0 60 h-100 a30 30 0 0 1 0 -60 Z`;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const q = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Moves its parent group along a path; with reduced motion, parks it at a fixed point on the path. */
function Motion({ path, still, at, dur, begin }: { path: string; still: boolean; at: number; dur: number; begin: number }) {
  return still ? (
    <animateMotion path={path} dur="1s" keyPoints={`${at};${at}`} keyTimes="0;1" calcMode="linear" rotate="auto" fill="freeze" />
  ) : (
    <animateMotion path={path} dur={`${dur}s`} begin={`${begin}s`} rotate="auto" repeatCount="indefinite" />
  );
}

export function AuthSky() {
  const still = useReducedMotion();
  return (
    <svg className="auth-sky" viewBox="0 0 600 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id="sky-scope" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#6ea2ff" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#6ea2ff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="sky-sweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#9cc0ff" stopOpacity="0" />
          <stop offset="100%" stopColor="#9cc0ff" stopOpacity="0.2" />
        </linearGradient>
      </defs>

      {/* Radar scope around the tower */}
      <g transform={`translate(${TOWER.x} ${TOWER.y})`}>
        <circle r="220" fill="url(#sky-scope)" />
        {[60, 120, 180, 240].map((r) => (
          <circle key={r} r={r} fill="none" stroke="#9cc0ff" strokeOpacity={0.13} strokeDasharray={r === 240 ? '3 7' : undefined} />
        ))}
        <path d="M-250 0 H250 M0 -250 V250" stroke="#9cc0ff" strokeOpacity="0.07" />
        {!still && (
          <path d="M0 0 L240 0 A240 240 0 0 0 207.8 -120 Z" fill="url(#sky-sweep)">
            <animateTransform attributeName="transform" type="rotate" from="0" to="-360" dur="7s" repeatCount="indefinite" />
          </path>
        )}
        {/* Blips the sweep lights up */}
        {[
          [110, -50, 0],
          [-140, 70, 2.4],
          [60, 150, 4.6],
          [-80, -150, 5.8],
        ].map(([x, y, b]) => (
          <circle key={`${x},${y}`} cx={x} cy={y} r="2.6" fill="#cfe0ff" opacity={still ? 0.6 : 0}>
            {!still && <animate attributeName="opacity" values="0;0.9;0" keyTimes="0;0.08;1" dur="7s" begin={`${b}s`} repeatCount="indefinite" />}
          </circle>
        ))}
        {/* The tower */}
        <circle r="15" fill="#0a1f45" stroke="#9cc0ff" strokeOpacity="0.55" />
        <path d="M-4.5 7 L-2.6 -2 H2.6 L4.5 7 Z M-7 -6.5 H7 L5.2 -2.2 H-5.2 Z M0 -10.5 V-6.5" fill="#cfe0ff" stroke="#cfe0ff" strokeWidth="0.8" strokeLinejoin="round" />
      </g>

      {/* Flights on their routes, each with a contrail that follows it */}
      {ROUTES.map((r, i) => (
        <g key={i}>
          <path d={r.d} fill="none" stroke="#9cc0ff" strokeOpacity="0.07" strokeDasharray="2 6" />
          {!still && (
            <path d={r.d} pathLength={100} fill="none" stroke="#cfe0ff" strokeWidth="1.6" strokeLinecap="round" strokeOpacity="0.35" strokeDasharray="9 200" strokeDashoffset="9">
              <animate attributeName="stroke-dashoffset" from="9" to="-100" dur={`${r.dur}s`} begin={`${r.begin}s`} repeatCount="indefinite" />
            </path>
          )}
          <g opacity="0.85">
            <path d={PLANE} fill="#eaf1ff" transform={`scale(${r.scale})`} />
            <Motion path={r.d} still={still} at={0.2 + i * 0.18} dur={r.dur} begin={r.begin} />
          </g>
        </g>
      ))}

      {/* Holding for clearance */}
      <path d={HOLD} fill="none" stroke="#f5b44a" strokeOpacity="0.3" strokeDasharray="3 5" />
      <g>
        <path d={PLANE} fill="#ffd28a" transform="scale(0.8)" />
        <Motion path={HOLD} still={still} at={0.1} dur={12} begin={0} />
      </g>
    </svg>
  );
}
