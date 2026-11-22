// Small line icons of the voting screen (stroke = currentColor).
const Svg = ({ children, size = 20 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
export const BackIcon = () => (
  <Svg>
    <path d="M19 12H5" />
    <path d="m11 18-6-6 6-6" />
  </Svg>
);
export const ForwardIcon = () => (
  <Svg>
    <path d="M5 12h14" />
    <path d="m13 6 6 6-6 6" />
  </Svg>
);
export const SkipIcon = () => (
  <Svg>
    <path d="m6 15 6-6 6 6" />
    <path d="m6 20 6-6 6 6" opacity=".45" />
  </Svg>
);
export const CommentIcon = () => (
  <Svg>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </Svg>
);
export const ZoomIcon = () => (
  <Svg size={18}>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </Svg>
);
export const FilterIcon = () => (
  <Svg size={16}>
    <path d="M3 5h18M6 12h12M10 19h4" />
  </Svg>
);
export function DeviceIcon({ device }: { device: string }) {
  return device === "phone" ? (
    <Svg size={14}>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </Svg>
  ) : (
    <Svg size={14}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </Svg>
  );
}
