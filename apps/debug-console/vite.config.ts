import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { main: 'index.html', voiceMotion: 'voice-motion.html' } } },
  publicDir: '../miniprogram/miniprogram/assets',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.BIO_API_PROXY || 'http://127.0.0.1:3000', ws: true },
    },
  },
});
