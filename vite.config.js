import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // 实时数据：/api → LLM 网关（server/gateway.mjs，默认 8787）
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
})
