// Line icons from the design system (24x24, stroke). Decorative: screen readers skip them.
// "c:cx,cy,r" draws a circle and "r:x,y,w,h,rx" a rectangle; anything else is a path.

const SHAPES = {
  truck: ["M3 6h11v10H3z", "M14 9h4l3 3v4h-7", "c:7,18,2", "c:17,18,2"],
  lock: ["r:5,11,14,10,2", "M8 11V7a4 4 0 0 1 8 0v4"],
  back: ["m15 6-6 6 6 6"],
  next: ["m9 6 6 6-6 6"],
  arrow: ["M5 12h14M13 6l6 6-6 6"],
  plus: ["M12 5v14M5 12h14"],
  check: ["m5 12 5 5 9-10"],
  qr: [
    "r:3,3,7,7,1",
    "r:14,3,7,7,1",
    "r:3,14,7,7,1",
    "M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3",
  ],
  search: ["c:11,11,7", "m20 20-3.5-3.5"],
  camera: ["M4 8h3l2-3h6l2 3h3v11H4z", "c:12,13,3.5"],
  image: ["r:3,4,18,16,2", "c:9,10,2", "m21 16-5-5-9 9"],
  video: ["r:3,6,13,12,2", "m16 10 5-3v10l-5-3"],
  warn: [
    "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
    "M12 9v4M12 17h.01",
  ],
  error: ["c:12,12,9", "M12 7v6M12 16.5v.01"],
  cross: ["c:12,12,9", "m15 9-6 6M9 9l6 6"],
  info: ["c:12,12,9", "M12 11v5M12 8h.01"],
  ok: ["c:12,12,9", "m8 12 3 3 5-6"],
  upload: ["M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8", "M12 12v8M9 15l3-3 3 3"],
  hourglass: ["M6 2h12M6 22h12M7 2v4l5 6 5-6V2M7 22v-4l5-6 5 6v4"],
  printer: ["M6 9V3h12v6", "r:3,9,18,8,2", "M6 14h12v7H6z"],
  clock: ["c:12,12,9", "M12 7v5l3 2"],
  wrench: [
    "M14.7 6.3a4 4 0 0 0-5.4 5.2l-5.8 5.8a1.8 1.8 0 0 0 2.5 2.5l5.8-5.8a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.3-.5-.5-2.3z",
  ],
  backspace: ["M9 5h11v14H9l-6-7z", "m13 9 4 6M17 9l-4 6"],
  device: ["r:4,2,16,20,2", "m9 9 6 6M15 9l-6 6"],
  inbox: ["M12 3v10", "m8 9 4 4 4-4", "M4 14h4l2 3h4l2-3h4v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"],
  calc: ["r:5,3,14,18,2", "M8 7h8M8 11h2M12 11h2M8 15h2M12 15h2M16 11v4"],
  pen: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"],
  box: ["M21 8 12 3 3 8v8l9 5 9-5z", "m3 8 9 5 9-5", "M12 13v8"],
  flag: ["M5 21V4", "M5 4h11l-2 4 2 4H5"],
  key: ["c:8,15,4", "m11 12 9-9", "m17 6 3 3"],
  cash: ["r:3,6,18,12,2", "c:12,12,2.5"],
  board: ["r:3,3,7,9,1", "r:14,3,7,5,1", "r:14,12,7,9,1", "r:3,16,7,5,1"],
  gauge: ["m12 14 4-4", "M3.34 19a10 10 0 1 1 17.32 0"],
} as const;

export type IconName = keyof typeof SHAPES;

function Shape({ spec }: { spec: string }) {
  if (spec.startsWith("c:")) {
    const [cx, cy, r] = spec.slice(2).split(",");
    return <circle cx={cx} cy={cy} r={r} />;
  }
  if (spec.startsWith("r:")) {
    const [x, y, width, height, rx] = spec.slice(2).split(",");
    return <rect x={x} y={y} width={width} height={height} rx={rx} />;
  }
  return <path d={spec} />;
}

export function Icon({
  name,
  size = 20,
  stroke = 2,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
}) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {SHAPES[name].map((spec) => (
        <Shape key={spec} spec={spec} />
      ))}
    </svg>
  );
}
