import { useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAccount, useSwitchChain } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Footer, Logo } from "@decentralpark/ui";
import { CaretDownIcon, ListIcon, XIcon } from "@phosphor-icons/react";
import { DEPLOYMENTS, useActiveDeployment } from "../chain/registry";
import { NotDeployedBanner, WrongNetworkBanner } from "./Banners";
import { Toasts } from "./Toasts";

/** Legacy multi-market nav entries stay hidden unless explicitly re-exposed
 * (the routes themselves are always registered). */
const SHOW_LEGACY_ROUTES =
  import.meta.env.VITE_SHOW_LEGACY_ROUTES === "1";

type NavDestination = { to: string; label: string };
type NavItem = NavDestination | { label: string; children: NavDestination[] };
const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Home" },
  { label: "For renters / insurers", children: [
    { to: "/renter", label: "Renter" },
    { to: "/insurer", label: "Insurer" },
  ] },
  { to: "/market-view", label: "Market view" },
  ...(SHOW_LEGACY_ROUTES
    ? [
        { to: "/markets", label: "Markets" },
        { to: "/underwrite", label: "Underwrite" },
        { to: "/choose", label: "Help me choose" },
      ]
    : []),
  { to: "/buy", label: "Buy & Sell" },
  { to: "/redeem", label: "Redeem RENT" },
  { to: "/docs", label: "Docs" },
];

/** Route → document title (RentSafe rebrand). */
const TITLES: [prefix: string, title: string][] = [
  ["/market-view", "Price as a forecast"],
  ["/renter", "For renters"],
  ["/insurer", "For insurers"],
  ["/markets", "Markets"],
  ["/market/", "Market"],
  ["/buy", "Buy & Sell"],
  ["/trade", "Buy & Sell"],
  ["/settle", "Settle"],
  ["/redeem", "Redeem RENT"],
  ["/underwrite", "Underwrite"],
  ["/sponsor", "Underwrite"],
  ["/choose", "Help me choose"],
  ["/docs/uniswap", "How Uniswap powers RENT"],
  ["/docs/walkthrough", "Watch the walkthrough"],
  ["/docs", "Docs"],
];

function usePageTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    const match = TITLES.find(([prefix]) => pathname.startsWith(prefix));
    document.title = match
      ? `RentSafe — ${match[1]}`
      : "RentSafe — protection for when rent goes up";
  }, [pathname]);
}

const navClass = (active: boolean) =>
  `font-parkBody text-sm whitespace-nowrap px-1 py-2 border-b-2 transition-colors rounded-t-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-core-green ${
    active ? "border-core-green text-core-green font-bold" : "border-transparent text-text-standard hover:text-core-green"
  }`;

function NavDropdown({ label, items, open, onToggle, onClose, onNavigate, mobile }: {
  label: string;
  items: NavDestination[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onNavigate?: () => void;
  mobile: boolean;
}) {
  const { pathname } = useLocation();
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusFirst = useRef(false);
  const active = items.some(({ to }) => pathname === to);

  useEffect(() => {
    if (!open) return;
    if (focusFirst.current) {
      container.current?.querySelector<HTMLAnchorElement>("a")?.focus();
      focusFirst.current = false;
    }
    const dismiss = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) onClose();
    };
    // Wait for click: collapsing an inline mobile group on pointerdown moves
    // the next trigger away before pointerup can activate it.
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [open, onClose]);

  return (
    <div
      ref={container}
      className={mobile ? "w-full" : "relative"}
      onBlur={(event) => {
        if (!mobile && !event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          if (open) container.current?.querySelector<HTMLAnchorElement>("a")?.focus();
          else { focusFirst.current = true; onToggle(); }
        }}
        className={`${navClass(active)} flex items-center gap-1.5 ${mobile ? "w-full justify-between" : ""}`}
      >
        {label}
        <CaretDownIcon size={14} weight="bold" aria-hidden="true" className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div id={id} className={mobile
          ? "mt-2 ml-1 border-l-2 border-paper-2 pl-3 flex flex-col gap-1"
          : "absolute left-0 top-full mt-2 z-40 min-w-48 rounded-xl border-2 border-paper-2 bg-paper-0 p-2 shadow-lg flex flex-col gap-1"}>
          {items.map((item) => (
            <NavLink key={item.to} to={item.to}
              onClick={() => { onClose(); onNavigate?.(); }}
              className={({ isActive }) => `rounded-lg px-3 py-2.5 font-parkBody text-sm transition-colors focus-visible:outline-2 focus-visible:outline-core-green ${
                isActive ? "bg-paper-1 text-core-green font-bold" : "text-text-standard hover:bg-paper-1 hover:text-core-green"
              }`}>
              {item.label}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function NavLinks({ onNavigate, mobile = false }: { onNavigate?: () => void; mobile?: boolean }) {
  const [openSection, setOpenSection] = useState<string | null>(null);
  return (
    <>
      {NAV_ITEMS.map((item) => "children" in item ? (
        <NavDropdown key={item.label} label={item.label} items={item.children}
          open={openSection === item.label}
          onToggle={() => setOpenSection(current => current === item.label ? null : item.label)}
          onClose={() => setOpenSection(current => current === item.label ? null : current)} onNavigate={onNavigate} mobile={mobile} />
      ) : (
        <NavLink key={item.to} to={item.to} end={item.to === "/"}
          onClick={() => { setOpenSection(null); onNavigate?.(); }}
          className={({ isActive }) => navClass(isActive)}>
          {item.label}
        </NavLink>
      ))}
    </>
  );
}

/** Tiny chain roundel so the switcher reads at a glance — pure visual
 * identity keyed by chainId (the accessible name is the select's own,
 * data-driven deployment name). */
function ChainLogo({ chainId }: { chainId: number }) {
  const style =
    chainId === 100
      ? { bg: "#04795b", letter: "G" }
      : chainId === 42161
        ? { bg: "#2d374b", letter: "A" }
        : chainId === 137
          ? { bg: "#8247e5", letter: "P" }
          : { bg: "#6b7280", letter: "L" };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      aria-hidden="true"
      className="shrink-0"
    >
      <circle cx="9" cy="9" r="9" fill={style.bg} />
      <text
        x="9"
        y="12.5"
        textAnchor="middle"
        fontSize="10"
        fontWeight="bold"
        fill="white"
        fontFamily="sans-serif"
      >
        {style.letter}
      </text>
    </svg>
  );
}

/**
 * Header chain switcher: drives BOTH the app's active deployment context and,
 * when a wallet is connected, a wallet switchChain to match. A native select
 * keeps it fully keyboard- and screen-reader-accessible.
 */
function ChainSwitcher() {
  const { chainId, setChainId } = useActiveDeployment();
  const { isConnected, chainId: walletChainId } = useAccount();
  const { switchChain } = useSwitchChain();

  const options = Object.values(DEPLOYMENTS).sort(
    (a, b) => a.chainId - b.chainId,
  );

  function onChange(next: number) {
    setChainId(next);
    if (isConnected && walletChainId !== next) {
      // Best-effort: if the wallet refuses, the wrong-network banner takes
      // over with the same switch offer + failure copy.
      switchChain({ chainId: next });
    }
  }

  return (
    <label className="flex items-center gap-1.5 border-2 border-paper-2 rounded-full pl-2 pr-1 py-0.5 bg-paper-0">
      <span className="sr-only">Network</span>
      <ChainLogo chainId={chainId} />
      <select
        value={chainId}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Network"
        data-testid="chain-switcher"
        className="font-parkBody text-sm bg-transparent outline-none py-1 pr-1 cursor-pointer"
      >
        {options.map((d) => (
          <option key={d.chainId} value={d.chainId}>
            {d.name}
          </option>
        ))}
      </select>
    </label>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Brand navbar built from kit primitives (Logo + brand typography classes),
 * structured like @decentralpark/ui's Navbar but with RainbowKit's injected
 * ConnectButton instead of the kit AccountSection (which hard-requires the
 * Privy SDK at runtime — see final report deviation note).
 */
function AppNavbar() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1280px)");
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const burger = burgerRef.current;
    const focusables = () =>
      Array.from(menu?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    focusables()[0]?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      burger?.focus();
    };
  }, [open]);

  return (
    <header className="relative py-2.5 flex items-center justify-between gap-4">
      <Link to="/" className="flex items-center gap-3 shrink-0">
        <Logo size={28} />
        <span className="font-parkDisplay font-bold text-sm md:text-base text-primary-green border border-primary-green rounded-full px-3 py-0.5 whitespace-nowrap">
          RentSafe
        </span>
      </Link>

      {/* desktop nav */}
      <nav className="hidden xl:flex items-center gap-3" aria-label="Main navigation">
        <NavLinks />
        <ChainSwitcher />
        <ConnectButton
          showBalance={false}
          chainStatus="icon"
          accountStatus="address"
        />
      </nav>

      {/* Wallet access remains visible on mobile, as does the menu. */}
      <div className="flex items-center gap-3 xl:hidden">
        <ConnectButton showBalance={false} chainStatus="none" accountStatus="avatar" />
      <button
        ref={burgerRef}
        onClick={() => setOpen(true)}
        className="xl:hidden text-primary-green h-11 w-11 -mr-1.5 flex items-center justify-center"
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls="mobile-menu"
        aria-haspopup="dialog"
      >
        <ListIcon size={32} />
      </button>
      </div>
      {open ? (
        <div
          ref={menuRef}
          id="mobile-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className="bg-paper-main fixed inset-0 z-50 p-6 xl:hidden overflow-y-auto"
        >
          <div className="flex items-center justify-between mb-8">
            <Logo text="RentSafe" size={24} color="green" />
            <button
              onClick={() => setOpen(false)}
              className="text-primary-green h-11 w-11 -mr-1.5 flex items-center justify-center"
              aria-label="Close menu"
            >
              <XIcon size={32} />
            </button>
          </div>
          <nav className="flex flex-col gap-4">
            <NavLinks mobile onNavigate={() => setOpen(false)} />
            <div className="mt-2">
              <ChainSwitcher />
            </div>
            <div className="mt-2">
              <ConnectButton showBalance={false} chainStatus="icon" />
            </div>
          </nav>
        </div>
      ) : null}
    </header>
  );
}

export function Layout() {
  usePageTitle();
  return (
    <div className="min-h-screen flex flex-col">
      <NotDeployedBanner />
      <WrongNetworkBanner />
      <div className="max-w-6xl w-full mx-auto px-4 sm:px-6">
        <AppNavbar />
      </div>
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 space-y-8">
        <Outlet />
      </main>
      <Toasts />
      <div className="mt-10">
        <p className="font-parkBody text-xs text-surface-grey-2 text-center max-w-6xl w-full mx-auto px-4 sm:px-6 pb-1">
          RentSafe is built by Decentral Park. The contracts have not been audited.
        </p>
        <p className="font-parkBody text-xs text-surface-grey-2 text-center max-w-6xl w-full mx-auto px-4 sm:px-6 pb-4">
          The rent index that settles this market tracks Manhattan office
          rent (commercial, not residential).
        </p>
        <Footer />
      </div>
    </div>
  );
}
