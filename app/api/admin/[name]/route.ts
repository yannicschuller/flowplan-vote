import { handle } from "@/lib/http";
import { adminRoute } from "@/lib/routes";

// GET /api/admin/summary | votes | scenes | prompt | export (README "Admin API").
export const dynamic = "force-dynamic";
export const GET = async (request: Request, ctx: { params: Promise<{ name: string }> }) => {
  const { name } = await ctx.params;
  return handle(() => adminRoute(request, name));
};
