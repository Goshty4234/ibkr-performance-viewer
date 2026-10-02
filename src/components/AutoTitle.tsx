'use client';

import { useEffect } from 'react';

/** Site-wide: hovering any text cut by an ellipsis shows the full text as a native tooltip.
 * The title is set on first hover (only if the element has none), so nothing is added to the DOM up front. */
export default function AutoTitle() {
  useEffect(() => {
    const onOver = (e: MouseEvent) => {
      let el = e.target instanceof Element ? e.target : null;
      for (let depth = 0; el && depth < 5; depth += 1, el = el.parentElement) {
        if (el.hasAttribute('title')) return; // explicit tooltip wins
        if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) continue;
        if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1) {
          const cs = getComputedStyle(el);
          if (cs.textOverflow === 'ellipsis') {
            const text = (el.innerText || el.textContent || '').trim();
            if (text) el.setAttribute('title', text);
            return;
          }
        }
      }
    };
    document.addEventListener('mouseover', onOver, { passive: true });
    return () => document.removeEventListener('mouseover', onOver);
  }, []);
  return null;
}
