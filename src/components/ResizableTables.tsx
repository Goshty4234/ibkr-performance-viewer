'use client';

import { useEffect } from 'react';

/**
 * Lets the person drag the right edge of any table header to widen or narrow that column (long
 * portfolio names, for instance). Mounted once in the app shell: it watches the page and equips every
 * <table> that has a plain one-row header. Double-click an edge to reset the table. Widths are
 * remembered between visits. A table can opt out with data-no-resize.
 */

const STORE = 'ibkr-col-widths-v1';
const MIN_WIDTH = 48;
const HANDLE = 'col-resizer';

type Widths = Record<string, number[]>;

function loadAll(): Widths {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') as Widths;
  } catch {
    return {};
  }
}

function saveAll(all: Widths) {
  try {
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    /* storage unavailable: widths just are not remembered */
  }
}

function headerCells(table: HTMLTableElement): HTMLTableCellElement[] | null {
  const row = table.tHead?.rows[0];
  if (!row || row.cells.length < 2) return null;
  const cells = Array.from(row.cells);
  if (cells.some((c) => c.colSpan > 1)) return null;
  return cells;
}

function labelOf(th: HTMLElement): string {
  let text = '';
  th.childNodes.forEach((n) => {
    if (!(n instanceof HTMLElement && n.classList.contains(HANDLE))) text += n.textContent ?? '';
  });
  return text.trim();
}

function keyOf(table: HTMLTableElement, cells: HTMLElement[]): string {
  return `${location.pathname}|${cells.map(labelOf).join('|')}`;
}

function setColumnWidth(table: HTMLTableElement, index: number, px: number | null) {
  const apply = (el: HTMLElement | undefined) => {
    if (!el) return;
    if (px === null) {
      el.style.removeProperty('width');
      el.style.removeProperty('min-width');
      el.style.removeProperty('max-width');
    } else {
      el.style.width = `${px}px`;
      el.style.minWidth = `${px}px`;
      el.style.maxWidth = `${px}px`;
    }
  };
  for (const section of Array.from(table.tBodies).concat(table.tHead ? [table.tHead] : [])) {
    for (const row of Array.from(section.rows)) apply(row.cells[index]);
  }
}

function fixLayout(table: HTMLTableElement, widths: number[] | null) {
  if (!widths) {
    table.style.removeProperty('table-layout');
    table.style.removeProperty('width');
    table.style.removeProperty('min-width');
    return;
  }
  const total = widths.reduce((a, b) => a + b, 0);
  table.style.tableLayout = 'fixed';
  table.style.width = `${total}px`;
  table.style.minWidth = '100%';
}

function applyStored(table: HTMLTableElement, cells: HTMLElement[], stored: number[] | undefined) {
  if (!stored || stored.length !== cells.length) return;
  fixLayout(table, stored);
  stored.forEach((w, i) => setColumnWidth(table, i, w));
}

export default function ResizableTables() {
  useEffect(() => {
    const all = loadAll();
    const tables = new WeakSet<HTMLTableElement>();

    function equip(table: HTMLTableElement) {
      if (table.hasAttribute('data-no-resize')) return;
      const cells = headerCells(table);
      if (!cells) return;
      const key = keyOf(table, cells);

      if (!tables.has(table)) {
        tables.add(table);
      }
      // (Re)apply remembered widths: React may have replaced rows since the last pass.
      applyStored(table, cells, all[key]);

      cells.forEach((th, index) => {
        if (th.querySelector(`:scope > .${HANDLE}`)) return;
        if (getComputedStyle(th).position === 'static') th.style.position = 'relative';
        const handle = document.createElement('span');
        handle.className = HANDLE;
        handle.setAttribute('aria-hidden', 'true');
        handle.title = 'Glisser pour redimensionner · double-clic pour réinitialiser';

        handle.addEventListener('click', (e) => e.stopPropagation());
        handle.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          delete all[key];
          saveAll(all);
          fixLayout(table, null);
          cells.forEach((_, i) => setColumnWidth(table, i, null));
        });
        handle.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const current = headerCells(table);
          if (!current) return;
          // Freeze every column at its present width on the first drag, then move only this one.
          const widths = all[key]?.length === current.length
            ? [...all[key]]
            : current.map((c) => Math.round(c.getBoundingClientRect().width));
          fixLayout(table, widths);
          widths.forEach((w, i) => setColumnWidth(table, i, w));

          const startX = e.clientX;
          const startW = widths[index];
          handle.classList.add('col-resizing');
          handle.setPointerCapture(e.pointerId);

          const move = (ev: PointerEvent) => {
            widths[index] = Math.max(MIN_WIDTH, Math.round(startW + ev.clientX - startX));
            fixLayout(table, widths);
            setColumnWidth(table, index, widths[index]);
          };
          const up = () => {
            handle.classList.remove('col-resizing');
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
            all[key] = [...widths];
            saveAll(all);
          };
          handle.addEventListener('pointermove', move);
          handle.addEventListener('pointerup', up);
          handle.addEventListener('pointercancel', up);
        });
        th.appendChild(handle);
      });
    }

    let scheduled = false;
    function scan() {
      scheduled = false;
      document.querySelectorAll('table').forEach((t) => equip(t as HTMLTableElement));
    }
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(scan);
    }

    scan();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
