import type { Metadata } from 'next';
import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import AutoTitle from '@/components/AutoTitle';
import './globals.css';

const sans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Momentum Backtester',
  description: 'Backtests multi-portfolios (momentum, filtres MA, fusion) et suivi de performance des comptes Interactive Brokers',
  applicationName: 'Momentum Backtester',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/apple-icon.svg', type: 'image/svg+xml' }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${sans.variable} ${mono.variable}`}>
      <body>
        {children}
        <AutoTitle />
      </body>
    </html>
  );
}
