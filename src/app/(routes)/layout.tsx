import AppNavigation from "@/components/app-navigation";
import { getOptionalAuthenticatedUser } from "@/lib/auth/guards";
import { getFlightMapRuntimeMode } from "@/lib/runtime-mode";

export default async function RoutesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getOptionalAuthenticatedUser();
  const mode = getFlightMapRuntimeMode();
  return (
    <>
      <AppNavigation user={user} />
      {mode.kind !== "mvp-production" && (
        <div className={`runtime-mode runtime-mode-${mode.kind}`} role="status">
          <strong>{mode.label}</strong>
          <span>{mode.detail}</span>
        </div>
      )}
      {children}
      <footer>
        <span>Waypointer · private by default</span>
        <span>
          Authenticated owner workspace · Raw import fields stay server-side
        </span>
      </footer>
    </>
  );
}
