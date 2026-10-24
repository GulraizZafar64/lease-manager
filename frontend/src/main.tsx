import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import './styles/enhancements.css';
import './styles/dashboard.css';
import './styles/viz.css';
import './styles/forms.css';
import './styles/import.css';
import './styles/approvals.css';
import './styles/users.css';
import './styles/minimal.css';
import App from './App';
import { PlatformApp } from './platform/PlatformApp';
import { installErrorCapture } from './domain/enterprise';
import { ensureCompanies } from './domain/platform';

installErrorCapture();
// Before anything reads saved data: set up the company list (the first time, the existing workspace becomes the demo company).
ensureCompanies();

const base = import.meta.env.BASE_URL.replace(/\/$/, '');
const isPlatform = window.location.pathname === base + '/platform' || window.location.pathname.startsWith(base + '/platform/');

createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
        {isPlatform ? <PlatformApp /> : <App />}
    </StrictMode>,
);
