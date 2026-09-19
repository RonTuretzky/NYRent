import { Suspense, lazy, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { wagmiConfig } from "./chain/wagmi";
import { ActiveDeploymentProvider } from "./chain/registry";
import { Layout } from "./components/Layout";
import { Card, LoadingSkeleton } from "./components/States";
import { MarketOverview } from "./pages/MarketOverview";
import { MarketView } from "./pages/MarketView";
import { ActiveMarketAction } from "./components/ActiveMarketAction";
import { SeriesList } from "./pages/SeriesList";
import { Buy } from "./pages/Buy";
import { Redeem } from "./pages/Redeem";
import { Choose } from "./pages/Choose";
import { InsurerDashboard } from "./pages/InsurerDashboard";
import { RenterVisualizer } from "./pages/RenterVisualizer";

// Heavy routes load on demand: Settle drags in the DKIM/RSA emailkit, Docs and
// the underwriting console are long pages most visitors never open.
const SeriesDetail = lazy(() =>
  import("./pages/SeriesDetail").then((m) => ({ default: m.SeriesDetail })),
);
const Settle = lazy(() =>
  import("./pages/Settle").then((m) => ({ default: m.Settle })),
);
const SettlePicker = lazy(() =>
  import("./pages/Settle").then((m) => ({ default: m.SettlePicker })),
);
const Underwrite = lazy(() =>
  import("./pages/Underwrite").then((m) => ({ default: m.Underwrite })),
);
const Docs = lazy(() => import("./pages/Docs").then((m) => ({ default: m.Docs })));
const UniswapGuide = lazy(() => import("./pages/UniswapGuide").then((m) => ({ default: m.UniswapGuide })));
const Walkthrough = lazy(() => import("./pages/Walkthrough").then((m) => ({ default: m.Walkthrough })));
const LegacyLanding = lazy(() => import("./pages/Landing").then((m) => ({ default: m.Landing })));
const LegacyDocs = lazy(() => import("./pages/LegacyDocs").then((m) => ({ default: m.LegacyDocs })));

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
          <ActiveDeploymentProvider>
            <HashRouter>
              <Routes>
                <Route element={<Layout />}>
                  <Route path="/" element={<MarketOverview />} />
                  <Route path="/insurer" element={<InsurerDashboard />} />
                  <Route path="/renter" element={<RenterVisualizer />} />
                  <Route path="/market-view" element={<MarketView />} />
                  <Route path="/buy" element={<ActiveMarketAction action="buy"><Buy /></ActiveMarketAction>} />
                  <Route path="/trade" element={<ActiveMarketAction action="buy"><Buy /></ActiveMarketAction>} />
                  <Route path="/redeem" element={<ActiveMarketAction action="redeem"><Redeem /></ActiveMarketAction>} />
                  {/* Legacy multi-market pages: registered but out of nav
                      (VITE_SHOW_LEGACY_ROUTES=1 re-exposes the nav links).
                      Paths avoid the word "series". */}
                  <Route path="/markets" element={<SeriesList />} />
                  <Route
                    path="/market/:id"
                    element={suspend(<SeriesDetail />)}
                  />
                  <Route path="/buy/:id" element={<Buy />} />
                  <Route path="/choose" element={<Choose />} />
                  <Route path="/settle" element={<ActiveMarketAction action="settle">{suspend(<Settle />)}</ActiveMarketAction>} />
                  <Route path="/legacy/settle" element={suspend(<SettlePicker />)} />
                  <Route path="/settle/:id" element={suspend(<Settle />)} />
                  <Route path="/redeem/:id" element={<Redeem />} />
                  <Route
                    path="/underwrite"
                    element={suspend(<Underwrite />)}
                  />
                  {/* legacy sponsor-era route */}
                  <Route
                    path="/sponsor"
                    element={<Navigate to="/underwrite" replace />}
                  />
                  <Route path="/docs/uniswap" element={suspend(<UniswapGuide />)} />
                  <Route path="/docs/walkthrough" element={suspend(<Walkthrough />)} />
                  <Route path="/docs" element={suspend(<Docs />)} />
                  <Route path="/legacy/docs" element={suspend(<LegacyDocs />)} />
                  <Route path="/legacy/home" element={suspend(<LegacyLanding />)} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </HashRouter>
          </ActiveDeploymentProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
