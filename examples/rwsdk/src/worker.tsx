import { render, route } from "rwsdk/router";
import { defineApp } from "rwsdk/worker";

import { setTenantIdResolver } from "@shoplayer/database/context";

import { Document } from "@/app/document";
import { setCommonHeaders } from "@/app/headers";
import { Home } from "@/app/pages/home";
import { Products } from "@/app/pages/products";
import { Events } from "@/app/pages/events";

import { createProduct } from "./databases/actions/createProduct";
import { getProduct } from "./databases/actions/getProduct";
import { listProducts } from "./databases/actions/listProducts";
import { trackEvent } from "./databases/actions/trackEvent";
import { batchTrackEvents } from "./databases/actions/batchTrackEvents";
import { getEventCounts } from "./databases/actions/getEventCounts";

// Export Durable Object classes - the plugin generates these
// @ts-ignore
export { MainDatabaseDO, EventsDatabaseDO } from "virtual:shoplayer/databases/__durableObjects";

export type AppContext = {};

export default defineApp([
  setCommonHeaders(),
  ({ request }) => {
    const tenantId =
      request.headers.get("X-Tenant-ID") ??
      new URL(request.url).searchParams.get("tenant") ??
      "demo-shop";
    setTenantIdResolver(() => tenantId);
  },

  // API routes
  route("/api/products", {
    get: async () => {
      const products = await listProducts({ limit: 50, offset: 0 });
      return new Response(JSON.stringify(products), {
        headers: { "Content-Type": "application/json" },
      });
    },
    post: async ({ request }) => {
      const body = (await request.json()) as {
        name: string;
        description?: string;
        priceInCents: number;
      };
      const product = await createProduct({
        name: body.name,
        ...(body.description != null && { description: body.description }),
        priceInCents: body.priceInCents,
      });
      return new Response(JSON.stringify(product), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  }),

  route("/api/products/:id", {
    get: async ({ params }) => {
      const product = await getProduct({ productId: params.id });
      if (!product) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(product), {
        headers: { "Content-Type": "application/json" },
      });
    },
  }),

  route("/api/events", {
    post: async ({ request }) => {
      const body = (await request.json()) as {
        type: string;
        payload?: string;
        sessionId: string;
      };
      const event = await trackEvent({
        type: body.type,
        sessionId: body.sessionId,
        payload: body.payload,
      });
      return new Response(JSON.stringify(event), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  }),

  route("/api/events/batch", {
    post: async ({ request }) => {
      const body = (await request.json()) as {
        events: Array<{ type: string; payload?: string; sessionId: string }>;
      };
      const result = await batchTrackEvents({
        eventsJson: JSON.stringify(body.events),
      });
      return new Response(JSON.stringify(result), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  }),

  route("/api/events/counts", {
    get: async () => {
      const counts = await getEventCounts({});
      return new Response(JSON.stringify(counts), {
        headers: { "Content-Type": "application/json" },
      });
    },
  }),

  // UI routes
  render(Document, [
    route("/", Home),
    route("/products", Products),
    route("/events", Events),
  ]),
]);
