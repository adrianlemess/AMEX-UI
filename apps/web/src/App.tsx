import { useEffect, useState, type FormEvent } from 'react';
import { AmexAnalytics } from './amex/AmexAnalytics';

type Session = { username: string; csrfToken: string };
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [signup, setSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
      .then((result) => result.ok ? result.json() as Promise<Session> : null)
      .then((result) => setSession(result))
      .catch(() => setError('Cannot reach the API. Check that PostgreSQL and the API are running.'))
      .finally(() => setLoading(false));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const username = (form.elements.namedItem('username') as HTMLInputElement).value;
    const password = (form.elements.namedItem('password') as HTMLInputElement).value;
    setBusy(true); setError('');
    try {
      const response = await fetch(signup ? '/api/signup' : '/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error === 'username_already_registered' ? 'This username is already registered.' :
          body.error === 'invalid_credentials' ? 'Check your username and password (at least 12 characters).' : 'Could not authenticate. Please try again.');
      }
      setSession(await response.json() as Session);
      form.reset();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not authenticate.'); }
    finally { setBusy(false); }
  }

  async function logout() {
    if (!session) return;
    setBusy(true);
    try {
      const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: '{}' });
      if (!response.ok) throw new Error('Could not sign out.');
      setSession(null);
    } catch { setError('Could not sign out.'); }
    finally { setBusy(false); }
  }

  return <div className="shell">
    <header className="shell-header"><h1>AMEX Spending Analytics</h1>{session && <button type="button" disabled={busy} onClick={() => void logout()}>Sign out · {session.username}</button>}</header>
    {loading ? <p role="status">Loading your account…</p> : session ? <AmexAnalytics csrfToken={session.csrfToken} /> :
      <main className="content-card auth-card">
        <h2>{signup ? 'Create account' : 'Sign in'}</h2>
        <p className="muted">Your purchases belong only to your own account. Start with an empty AMEX workspace.</p>
        {error && <p role="alert" className="alert">{error}</p>}
        <form onSubmit={(event) => void submit(event)}>
          <label className="field">Username <input name="username" autoComplete="username" required minLength={3} maxLength={30} pattern="[a-z][a-z0-9_]{2,29}" title="3–30 lowercase letters, digits or underscores; start with a letter" /></label>
          <label className="field">Password <input name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} required minLength={12} maxLength={256} /></label>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</button>
        </form>
        <button type="button" className="auth-switch" onClick={() => { setSignup((value) => !value); setError(''); }}>
          {signup ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
      </main>}
  </div>;
}
