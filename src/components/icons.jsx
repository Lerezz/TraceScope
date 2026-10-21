// 内联 SVG 图标（stroke 风格，currentColor 继承）
const I = (p = {}) => ({
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  'aria-hidden': true, ...p,
})

export const IconChevron = (p) => <svg {...I(p)}><path d="M9 6l6 6-6 6" /></svg>
export const IconAlert = (p) => (
  <svg {...I(p)}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <path d="M12 9v4" /><path d="M12 17h.01" />
  </svg>
)
export const IconSearch = (p) => (
  <svg {...I(p)}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
)
export const IconClock = (p) => (
  <svg {...I(p)}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
)
export const IconZap = (p) => (
  <svg {...I(p)}><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg>
)
export const IconCoins = (p) => (
  <svg {...I(p)}>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
  </svg>
)
export const IconWallet = (p) => (
  <svg {...I(p)}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>
)
export const IconCopy = (p) => (
  <svg {...I(p)}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
)
export const IconCheck = (p) => <svg {...I(p)}><path d="M20 6 9 17l-5-5" /></svg>
export const IconArrowLeft = (p) => (
  <svg {...I(p)}><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
)
export const IconClose = (p) => (
  <svg {...I(p)}><path d="M18 6 6 18" /><path d="M6 6l12 12" /></svg>
)
export const IconUser = (p) => (
  <svg {...I(p)}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
)
export const IconLayers = (p) => (
  <svg {...I(p)}>
    <path d="M12 2 2 7l10 5 10-5-10-5z" />
    <path d="M2 17l10 5 10-5" />
    <path d="M2 12l10 5 10-5" />
  </svg>
)
export const IconCpu = (p) => (
  <svg {...I(p)}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <rect x="9.5" y="9.5" width="5" height="5" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </svg>
)
export const IconSparkles = (p) => (
  <svg {...I(p)}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
    <path d="M5 3v3M3.5 4.5h3M19 17v3M17.5 18.5h3" />
  </svg>
)
export const IconWrench = (p) => (
  <svg {...I(p)}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
)
export const IconBranch = (p) => (
  <svg {...I(p)}>
    <path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
)
export const IconLogo = (p = {}) => (
  <svg width={p.size || 17} height={p.size || 17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3.5" y="3.5" width="8" height="8" rx="2" />
    <rect x="12.5" y="12.5" width="8" height="8" rx="2" />
    <path d="M7.5 11.5v3a2 2 0 0 0 2 2h3" />
  </svg>
)
