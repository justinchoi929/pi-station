import { NextResponse } from "next/server";
import { piExecutable, readPiVersion } from "@/lib/pi-rpc-client";

export const dynamic = "force-dynamic";

export async function GET() {
  const executable = piExecutable();
  try {
    const version = await readPiVersion();
    return NextResponse.json({ available: true, executable, version }, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch {
    return NextResponse.json({ available: false, executable, version: null }, { headers: { "Cache-Control": "no-store" } });
  }
}
