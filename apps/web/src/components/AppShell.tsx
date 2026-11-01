import { useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';
import { useSession } from '../session/SessionProvider.js';
import { ConfirmDialog } from './ConfirmDialog.js';

// The signed-in frame: the product name, who is signed in, Log out, and Sign out everywhere, which
// ends every session of the account and so asks first.
export function AppShell() {
  const { account, logout, logoutAll, unsavedCount } = useSession();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  // Signing out with changes that are not saved asks first, whichever way out was chosen.
  const [unsaved, setUnsaved] = useState<{ count: number; then: 'logout' | 'logout-all' } | null>(null);

  async function onLogout(): Promise<void> {
    await logout();
    void navigate('/login', { replace: true });
  }

  function askOrDo(then: 'logout' | 'logout-all'): void {
    const count = unsavedCount();
    if (count > 0) setUnsaved({ count, then });
    else if (then === 'logout') void onLogout();
    else setConfirming(true);
  }

  async function onLogoutAll(): Promise<void> {
    setConfirming(false);
    await logoutAll();
    void navigate('/login', { replace: true });
  }

  return (
    <>
      <header className="shell-header">
        <nav className="actions" aria-label="Main">
          <Link to="/projects">Scrylux</Link>
          <Link to="/jobs">Jobs</Link>
        </nav>
        <div className="actions">
          <span>{account?.username}</span>
          <button type="button" onClick={() => askOrDo('logout')}>
            Log out
          </button>
          <button type="button" onClick={() => askOrDo('logout-all')}>
            Sign out everywhere
          </button>
        </div>
      </header>
      {unsaved && (
        <ConfirmDialog
          title={`Sign out without saving ${unsaved.count} ${unsaved.count === 1 ? 'change' : 'changes'}?`}
          message={`${unsaved.count === 1 ? 'It is' : 'They are'} lost if you sign out now.`}
          confirmLabel="Sign out"
          cancelLabel="Stay signed in"
          onConfirm={() => {
            const next = unsaved.then;
            setUnsaved(null);
            if (next === 'logout') void onLogout();
            else setConfirming(true);
          }}
          onCancel={() => setUnsaved(null)}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title="Sign out everywhere"
          message="Sign out on every device? You'll need to sign in again everywhere."
          confirmLabel="Sign out everywhere"
          onConfirm={() => void onLogoutAll()}
          onCancel={() => setConfirming(false)}
        />
      )}
      <main>
        <Outlet />
      </main>
    </>
  );
}
