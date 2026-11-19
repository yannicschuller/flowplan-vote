import { handle } from "@/lib/http";
import { votesRoute } from "@/lib/routes";

export const POST = (request: Request) => handle(() => votesRoute(request));
export const DELETE = (request: Request) => handle(() => votesRoute(request));
