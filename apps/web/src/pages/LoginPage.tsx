import { Navigate, useLocation } from 'react-router';
import { useSession } from '../session/SessionProvider.js';
import { SignInForm } from '../session/SignInForm.js';

interface Origin {
  pathname: string;
  search?: string;
  hash?: string;
}

// Where to go after signing in: the page the user originally asked for, if the guard recorded one.
function returnTarget(state: unknown): string {
  const from = (state as { from?: Origin } | null)?.from;
  // Only an in-app path is ever followed.
  if (from && from.pathname.startsWith('/') && !from.pathname.startsWith('//')) {
    return `${from.pathname}${from.search ?? ''}${from.hash ?? ''}`;
  }
  return '/projects';
}

export function LoginPage() {
  const { status, signIn, endedMessage } = useSession();
  const location = useLocation();

  if (status === 'signed-in') return <Navigate to={returnTarget(location.state)} replace />;
  if (status === 'checking') return <p className="page">Loading…</p>;

  return (
    <main>
      <h1>Sign in to Scrylux</h1>
      {endedMessage && <p role="status">{endedMessage}</p>}
      <SignInForm onSubmit={signIn} />
    </main>
  );
}
