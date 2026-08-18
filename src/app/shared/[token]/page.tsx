import type { Metadata } from "next";
import { SharedMapView } from "@/components/shared-map-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared Waypointer map",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
  referrer: "no-referrer",
};

export default async function SharedMapPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <SharedMapView publicId={token} />;
}
