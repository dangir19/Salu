import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./extended.css";
import "./extended2.css";
import "./responsive.css";
import "./audit.css";
import "./audit2.css";
import "./network.css";
import "./membership.css";
import "./about.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#173b33",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://joinsalu.com"),
  title: "Salu — Your health concierge",
  description: "Premium self-pay wellness, recovery and personal care in Miami.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "Salu — Your health concierge",
    description: "In-home wellness, beautifully handled.",
    url: "https://joinsalu.com",
    siteName: "Salu",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Salu — In-home wellness, beautifully handled." }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Salu — Your health concierge",
    description: "In-home wellness, beautifully handled.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
