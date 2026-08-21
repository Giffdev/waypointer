import type { Metadata } from "next";
import { SharedMapView } from "@/components/shared-map-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Public Waypointer map",
};

export default async function PublicHandleMapPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  return <SharedMapView handle={handle} />;
}
