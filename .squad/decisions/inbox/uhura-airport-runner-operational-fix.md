### 2026-08-18: Refresh provider proof and support persisted Neon CLI auth
**By:** Uhura
**What:** The guided airport release runner now regenerates and hash-binds a fresh Vercel provider expectation from the pinned live deployment at the start of every run. It uses a global `neonctl` application when present, otherwise the exact `npx --yes neonctl` executable/argument pair, including child-process snapshot verification and rollback instructions. Provider and Neon verification remain fail-closed with one authentication action.
**Why:** `npx --yes neonctl auth` persists authentication without placing `neonctl` on `PATH`, and a 30-minute provider expectation cannot safely be reused on a later operator attempt.
