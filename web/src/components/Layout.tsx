import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Footer, Logo } from "@decentralpark/ui";
import { ListIcon, XIcon } from "@phosphor-icons/react";
import { NotDeployedBanner, WrongNetworkBanner } from "./Banners";
import { Toasts } from "./Toasts";

const NAV_ITEMS = [
  { to: "/series", label: "Series" },
  { to: "/settle", label: "Settle" },
  { to: "/sponsor", label: "Sponsor" },
  { to: "/docs", label: "Docs" },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          className={({ isActive }) =>
            `font-parkBody text-base px-1 py-2 md:py-1 border-b-2 transition-colors ${
              isActive
                ? "border-core-green text-core-green font-bold"
                : "border-transparent text-text-standard hover:text-core-green"
            }`
          }
        >
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
    if (!open) return;
    const menu = menuRef.current;
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
      burgerRef.current?.focus();
    };
  }, [open]);

  return (
    <header className="relative py-2.5 flex items-center justify-between gap-4">
      <Link to="/" className="flex items-center gap-3 shrink-0">
        <Logo size={24} className="md:hidden" />
        <span className="hidden md:block lg:text-2xl">
          <Logo text="Decentral Park" size={24} color="green" />
        </span>
        <span className="font-parkDisplay font-bold text-sm md:text-base text-primary-green border border-primary-green rounded-full px-3 py-0.5 whitespace-nowrap">
          NY Rent Cover
        </span>
      </Link>

      {/* desktop nav */}
      <nav className="hidden md:flex items-center gap-5">
        <NavLinks />
        <ConnectButton
          showBalance={false}
          chainStatus="icon"
          accountStatus="address"
        />
      </nav>

      {/* mobile burger */}
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
      {open ? (
        <div
          ref={menuRef}
          id="mobile-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className="bg-paper-main fixed inset-0 z-50 p-6 md:hidden overflow-y-auto"
        >
          <div className="flex items-center justify-between mb-8">
            <Logo text="NY Rent Cover" size={24} color="green" />
            <button
              onClick={() => setOpen(false)}
              className="text-primary-green h-11 w-11 -mr-1.5 flex items-center justify-center"
              aria-label="Close menu"
            >
              <XIcon size={32} />
            </button>
          </div>
          <nav className="flex flex-col gap-4">
            <NavLinks onNavigate={() => setOpen(false)} />
            <div className="mt-4">
              <ConnectButton showBalance={false} chainStatus="icon" />
            </div>
          </nav>
        </div>
      ) : null}
    </header>
  );
}

export function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <NotDeployedBanner />
      <WrongNetworkBanner />
      <div className="max-w-6xl w-full mx-auto px-4 sm:px-6">
        <AppNavbar />
      </div>
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6">
        <Outlet />
      </main>
      <Toasts />
      <div className="mt-10">
        <p className="font-parkBody text-xs text-surface-grey-2 text-center max-w-6xl w-full mx-auto px-4 sm:px-6 pb-4">
          Unaudited software. Fully collateralized but experimental — use tiny
          amounts. The index is commercial office rent (CompStak via CRE
          Daily), not residential.
        </p>
        <Footer />
      </div>
    </div>
  );
}
