import React from 'react';
import ReactDOM from 'react-dom/client';
// Imported for its side effect, and imported here rather than from a component:
// it must start listening for beforeinstallprompt before React renders, since
// Chrome offers that event exactly once and a late listener misses it for good.
import './lib/install';
import { App } from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
