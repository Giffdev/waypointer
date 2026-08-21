import type { Metadata } from "next";
import { SharedMapPreview } from "@/components/shared-map-preview";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Waypointer shared map preview",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
  referrer: "no-referrer",
};

export default function SharedMapPreviewPage() {
  return <SharedMapPreview />;
}
