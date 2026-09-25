/**
 * dsh-sub-providers — client half. Registers the Settings → Subscriptions
 * section, the composer usage pill, and the locale dictionaries. All host
 * communication goes through the package-private connection RPC channel; this
 * bundle performs no network I/O of its own.
 */
import React from "react";
import type { Context } from "@deepseek-ai/cordis";
import { DICTIONARIES, NS, type LocaleApi } from "./locale.ts";
import { SubProvidersClient, type RpcCaller } from "./rpc.ts";
import { SubscriptionsSection } from "./SubscriptionsSection.tsx";
import { UsagePill } from "./UsagePill.tsx";

/** Services this client half consumes. */
export const inject: string[] = ["connection", "locale", "slots"];

interface SlotsApi {
  inject(name: string, callback: () => void): void;
  register(registration: Record<string, unknown>, component: unknown): () => void;
}

interface ClientContext {
  connection: { rpc: RpcCaller };
  slots: SlotsApi;
  locale: LocaleApi;
}

export function apply(ctx: Context): void {
  const { connection, slots, locale } = ctx as unknown as ClientContext;
  const client = new SubProvidersClient(connection.rpc);

  ctx.effect(() => locale.register(NS, DICTIONARIES), "dsh-sub-providers: dictionaries");

  slots.inject("settings.section", () => {
    slots.register(
      {
        name: "settings.section",
        id: "sub-providers",
        order: 60,
        label: () => locale.bind(NS)("nav"),
      },
      () => React.createElement(SubscriptionsSection, { client, locale }),
    );
  });

  slots.inject("conversation.input.right", () => {
    slots.register(
      {
        name: "conversation.input.right",
        id: "sub-providers-usage",
        order: 60,
        locale: NS,
      },
      () => React.createElement(UsagePill, { client, locale }),
    );
  });
}
