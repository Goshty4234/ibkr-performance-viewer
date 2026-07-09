'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import styles from './Header.module.css';

interface Props {
  email?: string | null;
}

function initials(email?: string | null): string {
  if (!email) return '?';
  return email.charAt(0).toUpperCase();
}

export default function Header({ email }: Props) {
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

  async function handleSignOut() {
    await createClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  const isDashboard = pathname === '/' || pathname.startsWith('/compte');

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <Link href="/" className={styles.brand}>
          <span className={styles.logo}>📈</span>
          <span className={styles.brandText}>IBKR Performance</span>
        </Link>
        <nav className={styles.nav} aria-label="Navigation principale">
          <Link href="/" className={`${styles.navLink} ${isDashboard ? styles.navLinkActive : ''}`}>
            Mes comptes IBKR
          </Link>
          <Link href="/settings" className={`${styles.navLink} ${pathname === '/settings' ? styles.navLinkActive : ''}`}>
            Paramètres
          </Link>
        </nav>
      </div>

      <div className={styles.right}>
        <nav className={styles.mobileNav} aria-label="Navigation mobile">
          <Link href="/" className={`${styles.navLink} ${isDashboard ? styles.navLinkActive : ''}`}>📊</Link>
          <Link href="/settings" className={`${styles.navLink} ${pathname === '/settings' ? styles.navLinkActive : ''}`}>⚙️</Link>
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
    </header>
  );
}
