// Stroke icons (24x24), built with createElementNS so no markup parsing is involved.

const P = {
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 2-2 5 5', 'M15.5 9.5h.01'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  text: ['M5 6h14', 'M5 10h14', 'M5 14h10', 'M5 18h7'],
  code: ['M9 8l-4 4 4 4', 'M15 8l4 4-4 4'],
  html: ['M4 4h16v16H4z', 'M4 9h16', 'M9 20V9'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  pin: ['M9 4h6l-1 6 3 3H7l3-3z', 'M12 13v7'],
  paste: ['M9 4h6v3H9z', 'M8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2'],
  copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
  open: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  list: ['M8 6h12', 'M8 12h12', 'M8 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  compact: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  drop: ['M12 4v10', 'M8 10l4 4 4-4', 'M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3'],
  send: ['M4 12l16-8-6 16-2-7z'],
  action: ['M13 3L5 13h6l-1 8 8-10h-6z'],
};

export function icon(doc, name, { label } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'i');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  for (const d of P[name] || P.file) {
    const p = doc.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

export const ICON_NAMES = Object.keys(P);
