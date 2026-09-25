import React, { useEffect, useState } from "react";
import type { ProviderId, UsageReport } from "../shared/protocol.ts";
import { PROVIDER_NAMES, useTranslate, type LocaleApi } from "./locale.ts";
import type { SubProvidersClient } from "./rpc.ts";

interface PillItem {
  provider: ProviderId;
  name: string;
  percent: number;
  tooltip: string;
}

const styles = {
  root: {
    display: "inline-flex",
    gap: 6,
    alignItems: "center",
  } as React.CSSProperties,
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "1px 8px",
    borderRadius: 999,
    fontSize: 11,
    lineHeight: "16px",
    cursor: "default",
    color: "var(--dsw-alias-label-secondary, rgba(0,0,0,0.55))",
    background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06))",
  } as React.CSSProperties,
};

const REFRESH_MS = 5 * 60_000;

interface Props {
  client: SubProvidersClient;
  locale: LocaleApi;
}

/**
 * Compact subscription-usage pill for `conversation.input.right`: one pill per
 * logged-in provider showing the hottest usage window. Renders nothing when
 * nobody is signed in, keeping the composer clean.
 */
export function UsagePill({ client, locale }: Props): React.ReactElement | null {
  const t = useTranslate(locale);
  const [items, setItems] = useState<PillItem[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const status = await client.status();
        const loggedIn = status.providers.filter((entry) => entry.loggedIn);
        const reports = await Promise.all(
          loggedIn.map(async (entry) => {
            try {
              return await client.usage(entry.provider);
            } catch {
              return undefined;
            }
          }),
        );
        if (!alive) return;
        const next: PillItem[] = [];
        for (const report of reports) {
          if (report === undefined || !report.supported) continue;
          const item = toPillItem(report, t);
          if (item !== undefined) next.push(item);
        }
        setItems(next);
      } catch {
        // The pill is ambient: transport problems simply hide it.
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, t]);

  if (items.length === 0) return null;
  return (
    <span style={styles.root}>
      {items.map((item) => (
        <span key={item.provider} style={styles.pill} title={item.tooltip}>
          {item.name} {item.percent}%
        </span>
      ))}
    </span>
  );
}

function toPillItem(report: UsageReport, t: ReturnType<typeof useTranslate>): PillItem | undefined {
  const withPercent = report.windows.filter((window) => typeof window.usedPercent === "number");
  if (withPercent.length === 0) return undefined;
  const percent = Math.round(Math.max(...withPercent.map((window) => window.usedPercent as number)));
  const tooltip = report.windows
    .map((window) => {
      const parts = [`${window.label}: ${Math.round(window.usedPercent ?? 0)}%`];
      if (window.resetsAt !== undefined) parts.push(new Date(window.resetsAt).toLocaleString());
      return parts.join(" · ");
    })
    .join("\n");
  return {
    provider: report.provider,
    name: PROVIDER_NAMES[report.provider] ?? report.provider,
    percent,
    tooltip: tooltip.length > 0 ? tooltip : t("title"),
  };
}
