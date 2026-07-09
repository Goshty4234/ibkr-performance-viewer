import Header from './Header';
import styles from './AppShell.module.css';

interface Props {
  children: React.ReactNode;
  email?: string | null;
}

export default function AppShell({ children, email }: Props) {
  return (
    <div className={styles.shell}>
      <Header email={email} />
      <main className={styles.main}>{children}</main>
    </div>
  );
}
