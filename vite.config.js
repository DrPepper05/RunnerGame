import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Pollinations blocks browser CORS requests with Cloudflare Turnstile
      // ("Missing Turnstile token"), so the client calls same-origin
      // /api/pollinations/* and the dev server forwards it. Production hosts
      // need an equivalent rewrite (see CLAUDE.md).
      '/api/pollinations-text': {
        target: 'https://text.pollinations.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/pollinations-text/, '')
      },
      '/api/pollinations': {
        target: 'https://image.pollinations.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/pollinations/, '')
      }
    }
  },
  preview: {
    proxy: {
      '/api/pollinations-text': {
        target: 'https://text.pollinations.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/pollinations-text/, '')
      },
      '/api/pollinations': {
        target: 'https://image.pollinations.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/pollinations/, '')
      }
    }
  }
})
