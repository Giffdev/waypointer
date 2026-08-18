import { redirect } from "next/navigation";
import { LandingPage } from "@/components/landing/landing-page";
import { getOptionalAuthenticatedUser } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (await getOptionalAuthenticatedUser()) return redirect("/map");
  return <LandingPage />;
}
