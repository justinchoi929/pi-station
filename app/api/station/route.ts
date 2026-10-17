import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ application: "pi-station", version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0" });
}
