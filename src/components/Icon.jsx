import React from 'react';

const paths = {
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></>,
  feed: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/></>,
  star: <path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2L2.9 9.6l6.3-.9Z"/>,
  brain: <><path d="M12 5a3 3 0 0 0-5-2 3 3 0 0 0-4 4 4 4 0 0 0 0 7 3 3 0 0 0 4 4 3 3 0 0 0 5 2V5Zm0 0a3 3 0 0 1 5-2 3 3 0 0 1 4 4 4 4 0 0 1 0 7 3 3 0 0 1-4 4 3 3 0 0 1-5 2"/><path d="M7 7a3 3 0 0 1-1 4m12-4a3 3 0 0 0 1 4M8 16a3 3 0 0 0 4-3m4 3a3 3 0 0 1-4-3"/></>,
  code: <path d="m7 6-5 6 5 6m10-12 5 6-5 6m-3-15-4 18"/>,
  book: <><path d="M12 5C9 2 5 3 2 4v16c4-2 7-1 10 1 3-2 6-3 10-1V4c-3-1-7-2-10 1Z"/><path d="M12 5v16"/></>,
  source: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></>,
  report: <><path d="M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9Z"/><path d="M14 2v7h7M7 13h9M7 17h6"/></>,
  search: <><circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/></>,
  plus: <path d="M12 4v16M4 12h16"/>,
  play: <path d="m8 4 12 8-12 8Z"/>,
  list: <><path d="M4 5h16M4 12h16M4 19h16"/></>,
  columns: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  more: <><circle cx="4" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="20" cy="12" r="1"/></>,
  external: <><path d="M14 3h7v7m0-7L10 14"/><path d="M11 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.2"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  download: <><path d="M12 2v13m-5-5 5 5 5-5M3 16v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4"/></>,
  refresh: <><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
};

export default function Icon({ name, size = 20, filled = false, className = '' }) {
  return <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.feed}</svg>;
}
