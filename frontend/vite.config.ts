import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  // The backend (../backend) is reached through /api on the same origin, so its
  // session cookie and anti-forgery check work without cross-origin settings.
  const api = { '/api': { target: env.VITE_API_TARGET || 'http://127.0.0.1:8090', changeOrigin: false } };
  return {
    plugins: [react()],
    server: { proxy: api },
    preview: { proxy: api },
  };
});
