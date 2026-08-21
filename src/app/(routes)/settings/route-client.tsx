"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import {
  normalizeUsername,
  USERNAME_INPUT_PATTERN,
  USERNAME_REQUIREMENTS,
} from "@/lib/auth/username";
import type { DistanceUnit, OwnerProfile } from "@/lib/profile/service";
import { MapSharingPanel } from "@/components/map-sharing-panel";

export default function SettingsClient({
  initialProfile,
  configured,
  deletionEnabled,
  sharingAvailable = false,
}: {
  initialProfile: OwnerProfile;
  configured: boolean;
  deletionEnabled: boolean;
  sharingAvailable?: boolean;
}) {
  const [profile, setProfile] = useState(initialProfile);
  const [profileStatus, setProfileStatus] = useState("");
  const [profileSaveState, setProfileSaveState] = useState<
    "idle" | "saving" | "success" | "error"
  >("idle");
  const [usernameError, setUsernameError] = useState("");
  const [deletionStatus, setDeletionStatus] = useState("");
  const [developmentCancellationUrl, setDevelopmentCancellationUrl] =
    useState("");

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUsernameError("");
    setProfileSaveState("saving");
    setProfileStatus("Saving private profile…");
    try {
      const response = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: normalizeUsername(profile.username),
          displayName: profile.displayName,
          timeZone: profile.timeZone,
          distanceUnit: profile.distanceUnit,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setProfileSaveState("error");
        if (
          body.error?.code === "username-taken" ||
          body.error?.code === "invalid-username"
        ) {
          setUsernameError(body.error.message);
          setProfileStatus("");
          return;
        }
        setProfileStatus(body.error?.message ?? "Profile could not be saved.");
        return;
      }
      setProfile(body.profile);
      setProfileSaveState("success");
      setProfileStatus("Account settings saved.");
    } catch {
      setProfileSaveState("error");
      setProfileStatus("Profile could not be saved. Check your connection and try again.");
    }
  }

  const updateProfile = (next: OwnerProfile) => {
    setProfile(next);
    setProfileSaveState("idle");
    setProfileStatus("");
  };

  async function requestDeletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setDeletionStatus("Disabling account…");
    const response = await fetch("/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: form.get("confirmation"),
        password: form.get("password") || undefined,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setDeletionStatus(
        body.error?.message ?? "Account deletion could not be requested.",
      );
      return;
    }
    setDeletionStatus(
      `Account disabled. Check your verified email before ${new Date(
        body.graceExpiresAt,
      ).toLocaleString()} if you need to cancel deletion.`,
    );
    setDevelopmentCancellationUrl(body.developmentCancellationUrl ?? "");
  }

  return (
    <main className="app-shell" id="main-content" tabIndex={-1}>
      <section className="content-section route-page settings-page">
        <p className="eyebrow">Owner-only settings</p>
        <h1>Private account settings</h1>
        <p>
          Your email, display name, and preferences stay in your authenticated
          workspace. When you share your map, your username appears in the
          public URL. Anyone who knows or finds that username can open the map,
          but Waypointer never exposes your email in the link.
        </p>
        {!configured && (
          <p role="alert">
            Settings are unavailable in preview mode. Sign in to a configured
            private workspace to save changes.
          </p>
        )}

        <form className="settings-panel" onSubmit={saveProfile}>
          <h2>Profile preferences</h2>
          <label>
            Email
            <input value={profile.email} disabled />
          </label>
          <label htmlFor="settings-username">Username</label>
          <input
            id="settings-username"
            value={profile.username}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            minLength={3}
            maxLength={30}
            pattern={USERNAME_INPUT_PATTERN}
            required
            disabled={!configured}
            aria-invalid={usernameError ? "true" : undefined}
            aria-describedby={
              usernameError ? "username-hint username-error" : "username-hint"
            }
            onChange={(event) => {
              updateProfile({ ...profile, username: event.target.value });
              setUsernameError("");
            }}
          />
          <small id="username-hint">{USERNAME_REQUIREMENTS}</small>
          <small>
            Sharing uses /{normalizeUsername(profile.username) || "username"}.
            Usernames are visible in shared URLs and are not identity-verified
            by Waypointer. Saving a different username disables any current
            shared link.
          </small>
          {usernameError && (
            <small
              className="auth-message auth-message-error"
              id="username-error"
              role="alert"
            >
              {usernameError}
            </small>
          )}
          <label>
            Display name
            <input
              value={profile.displayName}
              maxLength={100}
              required
              disabled={!configured}
              onChange={(event) =>
                updateProfile({ ...profile, displayName: event.target.value })
              }
            />
          </label>
          <label>
            Distance unit
            <select
              value={profile.distanceUnit}
              disabled={!configured}
              onChange={(event) =>
                updateProfile({
                  ...profile,
                  distanceUnit: event.target.value as DistanceUnit,
                })
              }
            >
              <option value="miles">Miles</option>
              <option value="kilometers">Kilometers</option>
              <option value="nautical_miles">Nautical miles</option>
            </select>
          </label>
          <button
            className={`primary-button profile-save-button ${profileSaveState}`}
            type="submit"
            disabled={!configured || profileSaveState === "saving"}
            aria-busy={profileSaveState === "saving"}
          >
            {profileSaveState === "saving"
              ? "Saving…"
              : profileSaveState === "success"
                ? "Saved"
                : "Save profile"}
          </button>
          <p
            className={`profile-save-status ${profileSaveState}`}
            role={profileSaveState === "error" ? "alert" : "status"}
          >
            {profileStatus}
          </p>
        </form>

        {configured && sharingAvailable && (
          <MapSharingPanel key={profile.username} />
        )}

        {deletionEnabled ? (
        <form className="settings-panel danger-panel" onSubmit={requestDeletion}>
          <h2>Delete account</h2>
          <p>
            Requesting deletion immediately disables login, revokes sessions,
            and cancels queued work. A single-use cancellation link is sent to
            your verified email for the seven-day grace period.
          </p>
          {profile.hasPassword && (
            <label>
              Current password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={!configured}
              />
            </label>
          )}
          <label>
            Type DELETE to confirm
            <input
              name="confirmation"
              pattern="DELETE"
              required
              disabled={!configured}
            />
          </label>
          <button type="submit" disabled={!configured}>Delete my account</button>
          <p role="status">{deletionStatus}</p>
          {developmentCancellationUrl && (
            <a href={developmentCancellationUrl}>
              Local or restricted-preview cancellation link
            </a>
          )}
        </form>
        ) : (
          <section className="settings-panel danger-panel">
            <h2>Delete account</h2>
            <p role="status">
              Account deletion is temporarily unavailable. Your account and
              data remain active and unchanged.
            </p>
          </section>
        )}
        {configured && <Link href="/auth/sign-out">Sign out</Link>}
      </section>
    </main>
  );
}
