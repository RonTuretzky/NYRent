import { Suspense, lazy, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { wagmiConfig } from "./chain/wagmi";
import { Layout } from "./components/Layout";
import { Card, LoadingSkeleton } from "./components/States";
import { Home } from "./pages/Home";

// The policy pages load on demand as one chunk: Record a rent drags in the
// DKIM/RSA email parser, which the home page never needs.
const PolicyList = lazy(() => import("./pages/Policies").then(m => ({ default: m.PolicyList })));
const CreatePolicy = lazy(() => import("./pages/Policies").then(m => ({ default: m.CreatePolicy })));
const PolicyDetail = lazy(() => import("./pages/Policies").then(m => ({ default: m.PolicyDetail })));
const SubmitAlert = lazy(() => import("./pages/Policies").then(m => ({ default: m.SubmitAlert })));
const PolicyGuide = lazy(() => import("./pages/Policies").then(m => ({ default: m.PolicyGuide })));

function RouteFallback() {
  return (
    <div className="max-w-2xl mx-auto">
      <Card>
        <LoadingSkeleton lines={5} />
      </Card>
    </div>
  );
}

function suspend(node: ReactNode) {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

const queryClient = new QueryClient();

export default function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={lightTheme({
            accentColor: "#16a34a",
            accentColorForeground: "white",
            borderRadius: "medium",
          })}
        >
          <HashRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<Home />} />
                <Route path="/policies" element={suspend(<PolicyList />)} />
                <Route path="/policies/new" element={suspend(<CreatePolicy />)} />
                <Route path="/policies/submit" element={suspend(<SubmitAlert />)} />
                <Route path="/policies/guide" element={suspend(<PolicyGuide />)} />
                <Route path="/policies/v1/:id" element={suspend(<PolicyDetail version="v1" />)} />
                <Route path="/policies/:id" element={suspend(<PolicyDetail version="v2" />)} />
                {/* Every retired office-market route (and anything else) lands on the home page. */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </HashRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
