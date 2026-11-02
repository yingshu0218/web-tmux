// 极简线性图标集：统一 1.4-1.6px 描边，随 currentColor 着色，无外部依赖
type P = { size?: number };

const base = (size: number) => ({
  width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const
});

export function IconGrid({ size = 15 }: P) {
  return (
    <svg {...base(size)}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}

export function IconTerminal({ size = 15 }: P) {
  return (
    <svg {...base(size)}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6.25l1.9 1.75-1.9 1.75" />
      <path d="M8.5 10.5h3" />
    </svg>
  );
}

export function IconServer({ size = 15 }: P) {
  return (
    <svg {...base(size)}>
      <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
      <rect x="2" y="9" width="12" height="4.5" rx="1" />
      <path d="M4.6 4.75h.01M4.6 11.25h.01" strokeWidth="1.8" />
    </svg>
  );
}

export function IconSliders({ size = 15 }: P) {
  return (
    <svg {...base(size)}>
      <path d="M2 5h2.2M6.8 5H14M2 11h5.2M9.8 11H14" />
      <circle cx="5.5" cy="5" r="1.5" />
      <circle cx="8.5" cy="11" r="1.5" />
    </svg>
  );
}

export function IconSearch({ size = 14 }: P) {
  return (
    <svg {...base(size)} strokeWidth={1.6}>
      <circle cx="7.2" cy="7.2" r="4.6" />
      <path d="M10.6 10.6L14 14" />
    </svg>
  );
}

export function IconUser({ size = 16 }: P) {
  return (
    <svg {...base(size)}>
      <circle cx="8" cy="5.6" r="2.6" />
      <path d="M2.9 13.4c.6-2.6 2.7-4 5.1-4s4.5 1.4 5.1 4" />
    </svg>
  );
}

export function IconKey({ size = 16 }: P) {
  return (
    <svg {...base(size)}>
      <circle cx="5.6" cy="5.6" r="2.9" />
      <path d="M7.7 7.7l5.4 5.4M11 11l1.4-1.4M12.4 12.4l1.3-1.3" />
    </svg>
  );
}

export function IconShield({ size = 16 }: P) {
  return (
    <svg {...base(size)}>
      <path d="M8 1.8l5 1.9v4.1c0 3.1-2.1 5.6-5 6.4-2.9-.8-5-3.3-5-6.4V3.7l5-1.9z" />
      <path d="M5.8 8.1l1.6 1.6 3-3.2" />
    </svg>
  );
}

export function IconEye({ size = 15 }: P) {
  return (
    <svg {...base(size)}>
      <path d="M1.5 8S3.8 4 8 4s6.5 4 6.5 4-2.3 4-6.5 4-6.5-4-6.5-4z" />
      <circle cx="8" cy="8" r="1.9" />
    </svg>
  );
}

export function IconEyeOff({ size = 15 }: P) {
  return (
    <svg {...base(size)}>
      <path d="M6.3 4.3A7 7 0 018 4c4.2 0 6.5 4 6.5 4a12 12 0 01-2.2 2.6" />
      <path d="M3.7 5.5A12.4 12.4 0 001.5 8S3.8 12 8 12c.8 0 1.5-.1 2.1-.4" />
      <path d="M2 2l12 12" />
    </svg>
  );
}

export function IconLock({ size = 16 }: P) {
  return (
    <svg {...base(size)}>
      <rect x="3.2" y="6.8" width="9.6" height="7" rx="1.4" />
      <path d="M5.6 6.8V5.2a2.4 2.4 0 014.8 0v1.6" />
    </svg>
  );
}

export function IconPin({ size = 14 }: P) {
  return (
    <svg {...base(size)} strokeWidth={1.5}>
      <path d="M6 1.8h4l-.5 4 2 2.2H4.5l2-2.2-.5-4z" />
      <path d="M8 8v6" />
    </svg>
  );
}

export function IconFolder({ size = 12 }: P) {
  return (
    <svg {...base(size)} strokeWidth={1.5}>
      <path d="M1.8 4.2a1.2 1.2 0 011.2-1.2h2.6l1.3 1.6h5.1a1.2 1.2 0 011.2 1.2v6.4a1.2 1.2 0 01-1.2 1.2H3a1.2 1.2 0 01-1.2-1.2V4.2z" />
    </svg>
  );
}

export function IconArrowRight({ size = 14 }: P) {
  return (
    <svg {...base(size)}>
      <path d="M3 8h9.4M9 4.5L12.5 8 9 11.5" />
    </svg>
  );
}

export function IconPlug({ size = 13 }: P) {
  return (
    <svg {...base(size)}>
      <path d="M5.5 1.8v3.4M10.5 1.8v3.4" />
      <path d="M3.6 5.2h8.8v2.1a3.4 3.4 0 01-3.4 3.4h-2a3.4 3.4 0 01-3.4-3.4V5.2z" />
      <path d="M8 10.7v3.5" />
    </svg>
  );
}
