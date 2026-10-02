'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { leaveGuest } from '@/lib/guest';
import { createClient } from '@/lib/supabase/client';
import EngineStatus from './backtest/EngineStatus';
import styles from './Header.module.css';

interface Props {
  email?: string | null;
  guest?: boolean;
}

const NO_ACCOUNT = '00000000-0000-0000-0000-000000000000';
const WARM_ROUTES = [
  '/',
  '/ibkr',
  '/settings',
  `/ibkr/compte/${NO_ACCOUNT}`,
  '/api/accounts',
  `/api/statements?portfolioAccountId=${NO_ACCOUNT}`,
  `/api/nav-series?portfolioAccountId=${NO_ACCOUNT}`,
  `/api/twr-series?portfolioAccountId=${NO_ACCOUNT}`,
];

function initials(email?: string | null): string {
  if (!email) return '?';
  return email.charAt(0).toUpperCase();
}

export default function Header({ email, guest = false }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  // Dev only: next dev compiles a route on first visit; compile the sections in the background
  // (with the session cookie) and keep them warm so switching sections is instant.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development' || guest) return;
    let stopped = false;
    const warm = async () => {
      for (const route of WARM_ROUTES) {
        if (stopped) return;
        try {
          await fetch(route, { headers: { RSC: '1' }, cache: 'no-store' });
        } catch {
          /* dev server restarting */
        }
      }
    };
    const first = setTimeout(warm, 2500);
    const keepAlive = setInterval(warm, 10 * 60_000);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(keepAlive);
    };
  }, [guest]);

  async function handleSignOut() {
    await createClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  function goToLogin() {
    leaveGuest();
    window.location.assign('/login');
  }

  const isBacktester = pathname === '/' || pathname.startsWith('/backtest');
  const isIbkr = pathname.startsWith('/ibkr');
  const isSettings = pathname === '/settings';

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <Link href="/" className={styles.brand}>
          <span className={styles.logo}>📈</span>
          <span className={styles.brandText}>Momentum Backtester</span>
        </Link>
        {!guest && (
          <>
            <nav className={styles.switcher} aria-label="Section">
              <Link href="/" prefetch className={`${styles.switchItem} ${isBacktester ? styles.switchItemActive : ''}`}>
                Backtester
              </Link>
              <Link href="/ibkr" prefetch className={`${styles.switchItem} ${isIbkr ? styles.switchItemActive : ''}`}>
                Comptes IBKR
              </Link>
            </nav>
            <nav className={styles.nav} aria-label="Navigation principale">
              <Link href="/settings" prefetch className={`${styles.navLink} ${isSettings ? styles.navLinkActive : ''}`}>
                Paramètres
              </Link>
            </nav>
          </>
        )}
      </div>

      {guest ? (
        <div className={styles.right}>
          <EngineStatus />
          <span className={styles.guestBadge} title="Rien n’est enregistré : historique, enregistrements et espace de travail disparaissent en fermant l’onglet.">
            Mode invité · rien n’est enregistré
          </span>
          <button type="button" className={styles.guestCta} onClick={goToLogin}>
            Se connecter / créer un compte
          </button>
        </div>
      ) : (
      <div className={styles.right}>
        <EngineStatus />
        <nav className={styles.mobileNav} aria-label="Navigation mobile">
          <Link href="/settings" className={`${styles.navLink} ${isSettings ? styles.navLinkActive : ''}`}>⚙️</Link>
        </nav>

        <div className={styles.menuWrap} ref={menuRef}>
          <button
            type="button"
            className={styles.menuBtn}
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-haspopup="true"
          >
            <span className={styles.avatar}>{initials(email)}</span>
            <span className={styles.email}>{email}</span>
            <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}>▼</span>
          </button>

          {open && (
            <div className={styles.dropdown} role="menu">
              <Link href="/settings" role="menuitem" onClick={() => setOpen(false)}>
                ⚙️ Paramètres du compte
              </Link>
              <div className={styles.divider} />
              <button type="button" role="menuitem" className={styles.dropdownDanger} onClick={handleSignOut}>
                Déconnexion
              </button>
            </div>
          )}
        </div>
      </div>
      )}
    </header>
  );
}
