import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Connexion — IBKR Performance',
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: '#06080d' }}>
      {children}
    </div>
  );
}
