import SettingsClient from "./route-client";
import { getOptionalAuthenticatedUser } from "@/lib/auth/guards";
import { getOwnerProfile, type OwnerProfile } from "@/lib/profile/service";
import { isAccountDeletionEnabled } from "@/lib/auth/capabilities";

export const dynamic = "force-dynamic";

const previewProfile: OwnerProfile = {
  email: "preview@example.test",
  username: "preview",
  displayName: "Preview aviator",
  timeZone: "UTC",
  distanceUnit: "nautical_miles",
  mapViewMode: "globe",
  hasPassword: false,
};

export default async function SettingsPage() {
  const user = await getOptionalAuthenticatedUser();
  const profile = user ? await getOwnerProfile(user.id) : previewProfile;
  const e2eConfigured =
    process.env.NODE_ENV !== "production" &&
    process.env.FLIGHT_MAP_E2E_ACCOUNT_SETTINGS === "true";
  return (
    <SettingsClient
      initialProfile={profile}
      configured={Boolean(user) || e2eConfigured}
      deletionEnabled={isAccountDeletionEnabled()}
      sharingAvailable={Boolean(user) || e2eConfigured}
    />
  );
}
