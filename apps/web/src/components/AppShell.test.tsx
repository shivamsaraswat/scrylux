import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionValue } from '../session/SessionProvider.js';
import { AppShell } from './AppShell.js';

// The signed-in header: who is signed in, Log out, and Sign out everywhere behind a confirmation.
function setup() {
  const value: SessionValue = {
    status: 'signed-in',
    account: { id: 7, username: 'ada' },
    endedMessage: null,
    explicitSignOut: false,
    unsaved: 0,
    registerUnsavedWork: vi.fn(() => () => undefined),
    unsavedCount: () => 0,
    reauth: vi.fn(),
    discardAndSignOut: vi.fn(),
    signIn: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    logoutAll: vi.fn().mockResolvedValue(undefined),
  };
  render(
    <SessionContext.Provider value={value}>
      <MemoryRouter initialEntries={['/projects']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/projects" element={<p>projects page</p>} />
          </Route>
          <Route path="/login" element={<p>login page</p>} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>,
  );
  return value;
}

describe('AppShell', () => {
  it('shows the product name as a link to the project list, and the signed-in username', () => {
    setup();
    const brand = screen.getByRole('link', { name: 'Scrylux' });
    expect(brand.getAttribute('href')).toBe('/projects');
    expect(screen.getByText('ada')).toBeTruthy();
    expect(screen.getByText('projects page')).toBeTruthy();
  });

  it('links to the Jobs page, and asks the API for nothing about jobs (Phase 3 Milestone 2, FR-061a)', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      setup();
      expect(screen.getByRole('link', { name: 'Jobs' }).getAttribute('href')).toBe('/jobs');
      // The header is a plain link: no count, no badge, and no request, so a page that shows no job never asks for one.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('logs out and goes to the sign-in page', async () => {
    const value = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(value.logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('login page')).toBeTruthy();
  });

  it('asks before signing out everywhere, and does nothing on Cancel', async () => {
    const value = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));

    expect(screen.getByText("Sign out on every device? You'll need to sign in again everywhere.")).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(value.logoutAll).not.toHaveBeenCalled();
    expect(screen.queryByText(/Sign out on every device/)).toBeNull();
    expect(screen.getByText('projects page')).toBeTruthy();
  });

  it('signs out everywhere on confirm, then goes to the sign-in page', async () => {
    const value = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    const dialog = document.querySelector('dialog') as HTMLElement;
    await userEvent.click(dialog.querySelector('button.danger') as HTMLElement);

    expect(value.logoutAll).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('login page')).toBeTruthy();
  });
});
