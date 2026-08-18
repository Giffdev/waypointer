import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import { FirebaseSessionCompletion } from "@/components/auth/firebase-session-completion";
import { firebasePublicConfig } from "@/lib/auth/firebase-config";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  applicationName: "Waypointer",
  title: {
    default: "Waypointer — Every flight, one living map",
    template: "%s · Waypointer",
  },
  description: "A private home for personal and commercial flight history.",
  openGraph: {
    type: "website",
    siteName: "Waypointer",
    title: "Waypointer — Every flight, one living map",
    description: "Turn your flight logs into a private interactive map and history.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const firebaseConfigured =
    Boolean(process.env.DATABASE_URL) && Boolean(firebasePublicConfig());
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {firebaseConfigured && <FirebaseSessionCompletion />}
        {children}
      </body>
    </html>
  );
}
