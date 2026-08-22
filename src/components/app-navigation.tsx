"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  ArrowDownToLine,
  ChevronDown,
  CircleUserRound,
  LogOut,
  Map as MapIcon,
  Plane,
  Settings,
} from "lucide-react";
import {
  getInitialFilters,
  serializeFiltersForHref,
} from "./dashboard-shared";
import { SessionSignOutButton } from "./auth/session-sign-out-button";

const routes = [
  { path: "/map", label: "Map", icon: MapIcon, sharesFilters: true },
  { path: "/flights", label: "Flights", icon: Plane, sharesFilters: true },
  { path: "/import", label: "Import", icon: ArrowDownToLine, sharesFilters: false },
  { path: "/settings", label: "Settings", icon: Settings, sharesFilters: false },
] as const;

export default function AppNavigation({
  onOpenAuth,
  user,
}: {
  onOpenAuth?: () => void;
  user?: { name?: string | null; email: string } | null;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const accountMenuId = useId();
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const restoreAccountFocusRef = useRef(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const filterQuery = serializeFiltersForHref(
    getInitialFilters(Object.fromEntries(searchParams.entries())),
  );
  const announcement = `${
    routes.find(({ path }) => path === pathname)?.label ?? "Waypointer"
  } page loaded`;

  const links = routes.map((route) => ({
    ...route,
    href: `${route.path}${route.sharesFilters ? filterQuery : ""}`,
    active: pathname === route.path,
  }));

  const skipToMain = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const target = document.getElementById("main-content");
    target?.focus();
    target?.scrollIntoView?.({ block: "start" });
  };

  useEffect(() => {
    if (!accountMenuOpen) {
      if (restoreAccountFocusRef.current) {
        restoreAccountFocusRef.current = false;
        accountButtonRef.current?.focus();
      }
      return;
    }
    accountMenuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]')
      ?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [accountMenuOpen]);

  const menuItems = () =>
    Array.from(
      accountMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
        [],
    );

  const openAccountMenu = () => {
    setAccountMenuOpen(true);
  };

  const closeAccountMenu = (restoreFocus = false) => {
    restoreAccountFocusRef.current = restoreFocus;
    setAccountMenuOpen(false);
  };

  const handleAccountMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems();
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      closeAccountMenu(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const routeLinks = (className: string, label: string) => (
    <nav className={className} aria-label={label}>
      {links.map(({ path, href, label: linkLabel, icon: Icon, active }) => (
        <Link
          key={path}
          href={href}
          className={active ? "active" : undefined}
          aria-current={active ? "page" : undefined}
        >
          <Icon size={17} aria-hidden="true" />
          <span>{linkLabel}</span>
        </Link>
      ))}
    </nav>
  );

  return (
    <>
      <a className="skip-link" href="#main-content" onClick={skipToMain}>
        Skip to main content
      </a>
      <p
        className="sr-only"
        role="status"
        aria-label="Route change"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
      <header className="topbar">
        <Link
          className="brand"
          href={`/map${filterQuery}`}
          aria-label="Waypointer home"
        >
          <span className="brand-mark"><Plane size={18} /></span>
          <span>Waypointer</span>
        </Link>
        {routeLinks("nav-links", "Primary navigation")}
        {user ? (
          <div className="account-menu" ref={accountMenuRef}>
            <button
              className="profile-button"
              type="button"
              ref={accountButtonRef}
              aria-label={`Account menu for ${user.email}`}
              aria-haspopup="menu"
              aria-expanded={accountMenuOpen}
              aria-controls={accountMenuOpen ? accountMenuId : undefined}
              onClick={() =>
                accountMenuOpen ? closeAccountMenu() : openAccountMenu()
              }
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  openAccountMenu();
                }
                if (event.key === "Escape") closeAccountMenu(true);
              }}
            >
              <CircleUserRound size={19} aria-hidden="true" />
              <span>{user.name || user.email}</span>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
            {accountMenuOpen ? (
              <div
                className="account-menu-popup"
                id={accountMenuId}
                role="menu"
                aria-label="Account actions"
                onKeyDown={handleAccountMenuKeyDown}
              >
                <Link
                  href="/settings"
                  role="menuitem"
                  onClick={() => closeAccountMenu()}
                >
                  <Settings size={16} aria-hidden="true" />
                  Settings
                </Link>
                <SessionSignOutButton role="menuitem">
                    <LogOut size={16} aria-hidden="true" />
                    Sign out
                </SessionSignOutButton>
              </div>
            ) : null}
          </div>
        ) : onOpenAuth ? (
          <button
            className="profile-button"
            onClick={onOpenAuth}
            aria-label="Preview account"
          >
            <CircleUserRound size={19} />
            <span>Preview account</span>
          </button>
        ) : (
          <Link
            className="profile-button"
            href="/auth/sign-in"
            aria-label="Sign in"
          >
            <CircleUserRound size={19} />
            <span>Sign in</span>
          </Link>
        )}
      </header>
      {routeLinks("mobile-nav", "Mobile primary navigation")}
    </>
  );
}
