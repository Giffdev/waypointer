import SettingsClient from "./route-client";
import { getOptionalAuthenticatedUser } from "@/lib/auth/guards";
import { getOwnerProfile, type OwnerProfile } from "@/lib/profile/service";
import { isAccountDeletionEnabled } from "@/lib/auth/capabilities";
import { DrizzleImportRepository } from "@/lib/db/repositories/drizzle-import-repository";
import { flightAirportSequence } from "@/lib/flight-data";

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
  const [profile, shareFlights] = user
    ? await Promise.all([
        getOwnerProfile(user.id),
        new DrizzleImportRepository()
          .listFlights(user.id)
          .then((flights) =>
            flights.map((flight) => {
              const sequence = flightAirportSequence(flight);
              return {
                id: flight.id,
                date: flight.date,
                kind: flight.kind,
                airportCodes: sequence.map(({ code }) => code),
                cities: sequence.map(({ city }) => city),
              };
            }),
          ),
      ])
    : [previewProfile, []];
  const e2eConfigured =
    process.env.NODE_ENV !== "production" &&
    process.env.FLIGHT_MAP_E2E_ACCOUNT_SETTINGS === "true";
  return (
    <SettingsClient
      initialProfile={profile}
      configured={Boolean(user) || e2eConfigured}
      deletionEnabled={isAccountDeletionEnabled()}
      shareFlights={shareFlights}
    />
  );
}
