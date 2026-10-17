import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "./App";
import TwinApp from "./twin/TwinApp";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// The mock-driven digital twin is the default experience. The original
// backend-connected dashboard remains available at `?mode=live`.
const liveMode = new URLSearchParams(window.location.search).get("mode") === "live";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {liveMode ? (
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    ) : (
      <TwinApp />
    )}
  </StrictMode>,
);
