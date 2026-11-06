import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import DeployApp from './deploy/DeployApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DeployApp />
  </StrictMode>,
);
