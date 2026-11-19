import { handle } from "@/lib/http";
import { healthRoute } from "@/lib/routes";

export const dynamic = "force-dynamic";
export const GET = () => handle(() => healthRoute());
