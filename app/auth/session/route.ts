import { createClient } from "@/lib/supabase/server";
import { authConfig } from "@/lib/supabase/config";
export async function GET() {
  if (!authConfig())
    return Response.json(
      { userId: null },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return Response.json(
    { userId: user?.id ?? null },
    {
      status: user ? 200 : 401,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
