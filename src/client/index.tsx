/**
 * dsh-sub-providers — client half. Registers the Settings → Subscriptions
 * section, the composer usage pill, and the locale dictionaries. All host
 * communication goes through the package-private connection RPC channel; this
 * bundle performs no network I/O of its own.
 *
 * Every registration is fault-isolated: a throw in one must never prevent the
 * others, since a failed apply() disposes even the entries that registered
 * fine.
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
  inject(name: string, callback: () => void | (() => void)): void;
  register(registration: Record<string, unknown>, component: unknown): () => void;
}

interface ClientContext {
  connection: { rpc: RpcCaller };
  slots: SlotsApi;
  locale: LocaleApi;
}

function safe(step: string, run: () => void): void {
  try {
    run();
  } catch (cause) {
    console.error(`dsh-sub-providers: ${step} failed`, cause);
  }
}

export function apply(ctx: Context): void {
  const { connection, slots, locale } = ctx as unknown as ClientContext;
  const client = new SubProvidersClient(connection.rpc);

  // The nav label: translated when dictionaries are live, readable otherwise.
  const navLabel = (): string => {
    const value = locale.bind(NS)("nav");
    return value === "nav" ? "Subscriptions" : value;
  };

  safe("dictionary registration", () => {
    ctx.effect(() => locale.register(NS, DICTIONARIES), "dsh-sub-providers: dictionaries");
  });

  safe("settings section registration", () => {
    slots.inject("settings.section", () =>
      slots.register(
        {
          name: "settings.section",
          id: "sub-providers",
          order: 60,
          label: navLabel,
        },
        () => React.createElement(SubscriptionsSection, { client, locale }),
      ),
    );
  });

  safe("usage pill registration", () => {
    slots.inject("conversation.input.right", () =>
      slots.register(
        {
          name: "conversation.input.right",
          id: "sub-providers-usage",
          order: 60,
        },
        () => React.createElement(UsagePill, { client, locale }),
      ),
    );
  });
}
