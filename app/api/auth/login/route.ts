import { handle } from "@/lib/http";
import { loginRoute } from "@/lib/routes";

export const dynamic = "force-dynamic";
export const GET = (request: Request) => handle(() => loginRoute(request));
