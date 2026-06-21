import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/app/",
  envDir: "../..",
  server: {
    port: Number(process.env.VITE_DEV_PORT) || 3210,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.PORT || 3211}`,
    },
  },
});
