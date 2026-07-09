import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'IBKR Performance Viewer',
  description: 'Suivez la performance TWRR de vos comptes Interactive Brokers',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
