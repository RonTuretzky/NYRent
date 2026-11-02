import { useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Footer, Logo } from "@decentralpark/ui";
import { CaretDownIcon, ListIcon, XIcon } from "@phosphor-icons/react";
import { WrongNetworkBanner } from "./Banners";
import { Toasts } from "./Toasts";

type NavDestination = { to: string; label: string };
type NavItem = NavDestination | { label: string; children: NavDestination[] };
const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Home" },
  { label: "Policies", children: [
    { to: "/policies", label: "Browse policies" },
    { to: "/policies/new", label: "Create a policy" },
    { to: "/policies/submit", label: "Record a rent" },
    { to: "/policies/guide", label: "Guide" },
  ] },
];

/** Route → document title. */
const TITLES: [prefix: string, title: string][] = [
  ["/policies/new", "Create a neighborhood policy"],
  ["/policies/submit", "Record a rent"],
  ["/policies/guide", "Neighborhood policies guide"],
  ["/policies", "Neighborhood policies"],
];

function usePageTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    const match = TITLES.find(([prefix]) => pathname.startsWith(prefix));
    document.title = match
      ? `RentSafe — ${match[1]}`
      : "RentSafe — neighborhood rent policies";
  }, [pathname]);
}

const navClass = (active: boolean, mobile = false) =>
  `font-parkBody ${mobile ? "text-base px-3 py-3 min-h-12" : "text-sm px-1 py-2 min-h-11 min-w-11 inline-flex items-center justify-center"} whitespace-nowrap border-b-2 transition-colors rounded-t-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-core-green ${
    active ? "border-core-green text-core-green font-bold" : "border-transparent text-text-standard hover:text-core-green"
  }`;

/** Desktop dropdown for a nav group (the mobile menu lists groups flat). */
function NavDropdown({ label, items, open, onToggle, onClose }: {
  label: string;
  items: NavDestination[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const { pathname } = useLocation();
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusFirst = useRef(false);
  const active = items.some(({ to }) => pathname === to || pathname.startsWith(`${to}/`));

  useEffect(() => {
    if (!open) return;
    if (focusFirst.current) {
      container.current?.querySelector<HTMLAnchorElement>("a")?.focus();
      focusFirst.current = false;
    }
    const dismiss = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [open, onClose]);

  return (
    <div
      ref={container}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
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
        className={`${navClass(active)} flex items-center gap-1.5`}
        data-testid={`nav-group-${label.toLowerCase()}`}
      >
        {label}
        <CaretDownIcon size={14} weight="bold" aria-hidden="true" className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div id={id} className="absolute right-0 top-full mt-2 z-40 min-w-52 rounded-xl border-2 border-paper-2 bg-paper-0 p-2 shadow-lg flex flex-col gap-1">
          {items.map((item) => (
            <NavLink key={item.to} to={item.to} end
              onClick={onClose}
              className={({ isActive }) => `rounded-lg px-3 py-3 min-h-11 font-parkBody text-sm transition-colors focus-visible:outline-2 focus-visible:outline-core-green ${
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
        mobile ? (
          <div key={item.label} className="flex flex-col">
            <p className="font-parkDisplay font-bold text-sm text-surface-grey-2 px-3 pt-2 pb-1">{item.label}</p>
            {item.children.map((child) => (
              <NavLink key={child.to} to={child.to} end onClick={onNavigate}
                className={({ isActive }) => navClass(isActive, true)}>
                {child.label}
              </NavLink>
            ))}
          </div>
        ) : (
          <NavDropdown key={item.label} label={item.label} items={item.children}
            open={openSection === item.label}
            onToggle={() => setOpenSection(current => current === item.label ? null : item.label)}
            onClose={() => setOpenSection(current => current === item.label ? null : current)} />
        )
      ) : (
        <NavLink key={item.to} to={item.to} end={item.to === "/"}
          onClick={() => { setOpenSection(null); onNavigate?.(); }}
          className={({ isActive }) => navClass(isActive, mobile)}>
          {item.label}
        </NavLink>
      ))}
    </>
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
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
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
      document.body.style.overflow = previousOverflow;
      burger?.focus();
    };
  }, [open]);

  return (
    <header className="relative py-2.5 flex items-center justify-between gap-2 sm:gap-4">
      <Link to="/" className="flex min-h-11 items-center gap-2 sm:gap-3 shrink-0">
        <Logo size={28} />
        <span className="font-parkDisplay font-bold text-sm md:text-base text-primary-green border border-primary-green rounded-full px-3 py-0.5 whitespace-nowrap">
          RentSafe
        </span>
      </Link>

      {/* desktop nav */}
      <nav className="hidden md:flex flex-wrap justify-end items-center gap-x-4 gap-y-1 min-w-0" aria-label="Main navigation">
        <NavLinks />
        <ConnectButton
          showBalance={false}
          chainStatus="icon"
          accountStatus="address"
        />
      </nav>

      {/* Wallet access remains visible on mobile, as does the menu. */}
      <div className="flex items-center gap-2 md:hidden">
        <ConnectButton label="Connect" showBalance={false} chainStatus="none" accountStatus="avatar" />
      <button
        ref={burgerRef}
        onClick={() => setOpen(true)}
        className="md:hidden text-primary-green h-11 w-11 -mr-1.5 flex items-center justify-center"
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
          className="bg-paper-main fixed inset-0 z-50 max-h-[100dvh] p-5 md:hidden overflow-y-auto overscroll-contain"
          style={{paddingTop: "max(1.25rem, env(safe-area-inset-top))", paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))"}}
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
          <nav className="flex flex-col gap-2" aria-label="Main navigation">
            <NavLinks mobile onNavigate={() => setOpen(false)} />
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
  const { pathname } = useLocation();
  // A new page starts at the top (hash routes otherwise keep the old scroll).
  useEffect(() => window.scrollTo(0, 0), [pathname]);
  return (
    <div className="min-h-screen flex flex-col">
      <WrongNetworkBanner />
      <div className="max-w-6xl w-full mx-auto px-4 sm:px-6">
        <AppNavbar />
      </div>
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 space-y-8">
        <Outlet />
      </main>
      <Toasts />
      <div className="mt-10">
        <p className="font-parkBody text-xs text-surface-grey-2 text-center max-w-6xl w-full mx-auto px-4 sm:px-6 pb-4">
          RentSafe is built by Decentral Park. The contracts have not been audited.
        </p>
        <Footer />
      </div>
    </div>
  );
}
