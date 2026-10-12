import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './api';
import { App } from './App';
import { ToastProvider } from './ui';
import '@fontsource-variable/inter';
import './theme/tokens.css';
import './styles.css';
import { applyTheme } from './theme/theme';

applyTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 401/403/404 will not fix themselves; network blips retry once.
      retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 1,
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
      staleTime: 1_000,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
