import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { wagmiConfig } from "./chain/wagmi";
import { Layout } from "./components/Layout";
import { Landing } from "./pages/Landing";
import { SeriesList } from "./pages/SeriesList";
import { SeriesDetail } from "./pages/SeriesDetail";
import { Buy } from "./pages/Buy";
import { Settle, SettlePicker } from "./pages/Settle";
import { Redeem } from "./pages/Redeem";
import { Sponsor } from "./pages/Sponsor";
import { Docs } from "./pages/Docs";

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
                <Route path="/series/:id" element={<SeriesDetail />} />
                <Route path="/buy/:id" element={<Buy />} />
                <Route path="/settle" element={<SettlePicker />} />
                <Route path="/settle/:id" element={<Settle />} />
                <Route path="/redeem/:id" element={<Redeem />} />
                <Route path="/sponsor" element={<Sponsor />} />
                <Route path="/docs" element={<Docs />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </HashRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
