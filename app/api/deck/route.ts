import { handle } from "@/lib/http";
import { deckRoute } from "@/lib/routes";

export const dynamic = "force-dynamic";
export const GET = (request: Request) => handle(() => deckRoute(request));
