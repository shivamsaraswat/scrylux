import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Navigate, Outlet, createBrowserRouter, type RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ApiError } from './api/errors.js';
import { AppShell } from './components/AppShell.js';
import { RouteError } from './components/RouteError.js';
import { JobPage } from './pages/JobPage.js';
import { JobsPage } from './pages/JobsPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { ProjectPage } from './pages/ProjectPage.js';
import { ProjectsPage } from './pages/ProjectsPage.js';
import { DiagramTab } from './pages/DiagramTab.js';
import { ThreatModelPage } from './pages/ThreatModelPage.js';
import { ThreatsTab } from './pages/ThreatsTab.js';
import { RequireSession } from './session/RequireSession.js';
import { SessionProvider } from './session/SessionProvider.js';

// Nothing refetches in the background: no interval, and no refetch on window focus or reconnect. Only
// user actions cause requests, so an idle tab doesn't keep its session alive past the idle limit.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => !(error instanceof ApiError && error.status < 500) && failureCount < 2,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 30_000,
    },
  },
});

// A shell for every route: the session lives inside the router, because a data router renders its
// route tree on its own and `RequireSession` and the pages read the session from context.
function Root() {
  return (
    <SessionProvider>
      <Outlet />
    </SessionProvider>
  );
}

// The routes as data, so tests can build the same tree with a memory router. The app is on a data
// router because `useBlocker`, which the diagram editor needs to warn before in-app navigation away
// from unsaved work, works only in one (Phase 2 / Milestone 1, research #10).
export const appRoutes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        element: <RequireSession />,
        children: [
          {
            element: <AppShell />,
            children: [
              {
                // A page that breaks shows a plain message inside the shell, not the router's default screen.
                errorElement: <RouteError />,
                children: [
                  { path: '/', element: <Navigate to="/projects" replace /> },
                  { path: '/projects', element: <ProjectsPage /> },
                  { path: '/projects/:projectId', element: <ProjectPage /> },
                  { path: '/jobs', element: <JobsPage /> },
                  { path: '/jobs/:jobId', element: <JobPage /> },
                  {
                    // The Threats tab is the page's own address, so existing links keep working.
                    path: '/threat-models/:threatModelId',
                    element: <ThreatModelPage />,
                    children: [
                      { index: true, element: <ThreatsTab /> },
                      { path: 'diagram', element: <DiagramTab /> },
                    ],
                  },
                  { path: '*', element: <NotFoundPage /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];

export function App() {
  const router = useMemo(() => createBrowserRouter(appRoutes), []);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
