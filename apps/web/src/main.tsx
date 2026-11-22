import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import './style.css';

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { console.error('Kart UI failed to render. Reload to recover.'); }
  render() {
    return this.state.failed
      ? <main><h1>Kart could not load</h1><p>Reload to recover your saved list.</p><button onClick={() => location.reload()}>Reload</button></main>
      : this.props.children;
  }
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } });
createRoot(document.getElementById('root')!).render(
  <Boundary><QueryClientProvider client={client}><BrowserRouter><App /></BrowserRouter></QueryClientProvider></Boundary>,
);
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js').catch(() => console.error('Kart install support could not start.'));
}
