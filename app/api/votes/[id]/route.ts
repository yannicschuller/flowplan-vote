import { handle } from "@/lib/http";
import { voteRoute } from "@/lib/routes";

type Ctx = { params: Promise<{ id: string }> };
const forward = async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  return handle(() => voteRoute(request, id));
};
export const PATCH = forward;
export const DELETE = forward;
