import { Suspense, lazy, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { wagmiConfig } from "./chain/wagmi";
import { Layout } from "./components/Layout";
import { Card, LoadingSkeleton } from "./components/States";
import { Landing } from "./pages/Landing";
import { SeriesList } from "./pages/SeriesList";
import { Buy } from "./pages/Buy";
import { Redeem } from "./pages/Redeem";

// Heavy routes load on demand: Settle drags in the DKIM/RSA emailkit, Docs and
// the sponsor console are long pages most visitors never open.
const SeriesDetail = lazy(() =>
  import("./pages/SeriesDetail").then((m) => ({ default: m.SeriesDetail })),
);
const Settle = lazy(() =>
  import("./pages/Settle").then((m) => ({ default: m.Settle })),
);
const SettlePicker = lazy(() =>
  import("./pages/Settle").then((m) => ({ default: m.SettlePicker })),
);
const Sponsor = lazy(() =>
  import("./pages/Sponsor").then((m) => ({ default: m.Sponsor })),
);
const Docs = lazy(() => import("./pages/Docs").then((m) => ({ default: m.Docs })));

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
                <Route path="/" element={<Landing />} />
                <Route path="/series" element={<SeriesList />} />
                <Route path="/series/:id" element={suspend(<SeriesDetail />)} />
                <Route path="/buy/:id" element={<Buy />} />
                <Route path="/settle" element={suspend(<SettlePicker />)} />
                <Route path="/settle/:id" element={suspend(<Settle />)} />
                <Route path="/redeem/:id" element={<Redeem />} />
                <Route path="/sponsor" element={suspend(<Sponsor />)} />
                <Route path="/docs" element={suspend(<Docs />)} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </HashRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
