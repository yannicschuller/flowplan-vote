import { handle } from "@/lib/http";
import { adminRoute } from "@/lib/routes";

// GET /api/admin/summary | votes | voters | scenes | prompt | export,
// POST /api/admin/votes/<id>/dismiss|restore, /api/admin/voters/<user>/dismiss|restore
// (README "Admin API").
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ path: string[] }> };
const forward = async (request: Request, ctx: Ctx) => {
  const { path } = await ctx.params;
  return handle(() => adminRoute(request, path));
};
export const GET = forward;
export const POST = forward;
