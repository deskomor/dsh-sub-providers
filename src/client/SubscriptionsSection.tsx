import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AccountSummary, ProviderId, StatusResponse, UsageReport } from "../shared/protocol.ts";
import { PROVIDER_NAMES, useTranslate, type LocaleApi, type Translate } from "./locale.ts";
import type { SubProvidersClient } from "./rpc.ts";

const styles = {
  section: { display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 } as React.CSSProperties,
  card: {
    border: "1px solid var(--border, #d8d8d8)",
    borderRadius: 10,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } as React.CSSProperties,
  title: { margin: 0, fontSize: 15, fontWeight: 600 } as React.CSSProperties,
  subtitle: { margin: 0, fontSize: 12, opacity: 0.75 } as React.CSSProperties,
  row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } as React.CSSProperties,
  button: { padding: "4px 12px", borderRadius: 6, cursor: "pointer" } as React.CSSProperties,
  hint: { fontSize: 12, opacity: 0.7 } as React.CSSProperties,
  meter: {
    height: 6,
    borderRadius: 3,
    background: "var(--border, #e5e5e5)",
    overflow: "hidden",
    flex: 1,
    minWidth: 120,
  } as React.CSSProperties,
  meterFill: { height: "100%", background: "var(--accent, #4b7bec)" } as React.CSSProperties,
  error: { color: "#c0392b", fontSize: 12 } as React.CSSProperties,
};

function formatReset(t: Translate, resetsAt: number | undefined): string {
  if (resetsAt === undefined) return "";
  const delta = resetsAt - Date.now();
  if (delta <= 0) return t("resetSoon");
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return t("resetMin", { minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("resetHours", { hours });
  return t("resetAt", { when: new Date(resetsAt).toLocaleString() });
}

interface SectionProps {
  client: SubProvidersClient;
  locale: LocaleApi;
}

/** Settings → Subscriptions: per-provider login state, sign-in/out, usage. */
export function SubscriptionsSection({ client, locale }: SectionProps): React.ReactElement {
  const t = useTranslate(locale);
  const [status, setStatus] = useState<StatusResponse | undefined>(undefined);
  const [usage, setUsage] = useState<Partial<Record<ProviderId, UsageReport>>>({});
  const [busy, setBusy] = useState<Partial<Record<ProviderId, boolean>>>({});
  const [pastePending, setPastePending] = useState<Partial<Record<ProviderId, boolean>>>({});
  const [codeText, setCodeText] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await client.status();
      if (mounted.current) setStatus(next);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client]);

  // Initial load, then poll while any login flow is pending.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const anyBusy = status?.providers.some((entry) => entry.busy === true) ?? false;
    if (!anyBusy) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [status, refresh]);

  const onLogin = useCallback(
    async (provider: ProviderId) => {
      setBusy((state) => ({ ...state, [provider]: true }));
      setError(undefined);
      try {
        const start = await client.login(provider);
        window.open(start.authorizeUrl, "_blank", "noopener,noreferrer");
        if (start.mode === "code-paste") {
          setCodeText("");
          setPastePending((state) => ({ ...state, [provider]: true }));
        }
        await refresh();
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (mounted.current) setBusy((state) => ({ ...state, [provider]: false }));
      }
    },
    [client, refresh],
  );

  const onSubmitCode = useCallback(
    async (provider: ProviderId) => {
      setError(undefined);
      try {
        await client.submitLogin(provider, codeText);
        if (mounted.current) {
          setPastePending((state) => ({ ...state, [provider]: false }));
          setCodeText("");
        }
        await refresh();
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [client, codeText, refresh],
  );

  const onCancel = useCallback(
    async (provider: ProviderId) => {
      try {
        await client.cancelLogin(provider);
        if (mounted.current) setPastePending((state) => ({ ...state, [provider]: false }));
        await refresh();
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [client, refresh],
  );

  const onLogout = useCallback(
    async (provider: ProviderId) => {
      try {
        await client.logout(provider);
        setUsage((state) => ({ ...state, [provider]: undefined }));
        if (mounted.current) setPastePending((state) => ({ ...state, [provider]: false }));
        await refresh();
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [client, refresh],
  );

  const onUsage = useCallback(
    async (provider: ProviderId, force = true) => {
      try {
        const report = await client.usage(provider, force);
        if (mounted.current) setUsage((state) => ({ ...state, [provider]: report }));
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [client],
  );

  const entries: AccountSummary[] = status?.providers ?? [];

  return (
    <div style={styles.section}>
      <div>
        <h3 style={styles.title}>{t("title")}</h3>
        <p style={styles.subtitle}>{t("subtitle")}</p>
      </div>
      {error !== undefined && <div style={styles.error}>{error}</div>}
      {entries.length === 0 && <div style={styles.hint}>{t("loading")}</div>}
      {entries.map((entry) => (
        <ProviderCard
          key={entry.provider}
          t={t}
          entry={entry}
          report={usage[entry.provider]}
          working={busy[entry.provider] === true}
          pastePending={pastePending[entry.provider] === true}
          codeText={codeText}
          onCodeChange={setCodeText}
          onSubmitCode={() => void onSubmitCode(entry.provider)}
          onLogin={() => void onLogin(entry.provider)}
          onCancel={() => void onCancel(entry.provider)}
          onLogout={() => void onLogout(entry.provider)}
          onUsage={() => void onUsage(entry.provider)}
        />
      ))}
    </div>
  );
}

interface CardProps {
  t: Translate;
  entry: AccountSummary;
  report: UsageReport | undefined;
  working: boolean;
  pastePending: boolean;
  codeText: string;
  onCodeChange(value: string): void;
  onSubmitCode(): void;
  onLogin(): void;
  onCancel(): void;
  onLogout(): void;
  onUsage(): void;
}

function ProviderCard({
  t,
  entry,
  report,
  working,
  pastePending,
  codeText,
  onCodeChange,
  onSubmitCode,
  onLogin,
  onCancel,
  onLogout,
  onUsage,
}: CardProps): React.ReactElement {
  const name = PROVIDER_NAMES[entry.provider] ?? entry.provider;
  const stateText = entry.busy === true
    ? t("pending")
    : entry.loggedIn
      ? `${entry.email !== undefined ? t("signedInAs", { email: entry.email }) : t("signedIn")}${entry.plan !== undefined ? ` · ${entry.plan}` : ""}`
      : t("notSignedIn");
  return (
    <div style={styles.card}>
      <div style={styles.row}>
        <h4 style={styles.title}>{name}</h4>
        <span style={styles.hint}>{stateText}</span>
      </div>
      <div style={styles.row}>
        {entry.loggedIn ? (
          <button style={styles.button} onClick={onLogout}>{t("signOut")}</button>
        ) : entry.busy === true || pastePending ? (
          <button style={styles.button} onClick={onCancel}>{t("cancel")}</button>
        ) : (
          <button style={styles.button} onClick={onLogin} disabled={working}>{t("signIn")}</button>
        )}
        {entry.loggedIn && (
          <button style={styles.button} onClick={onUsage}>{t("refreshUsage")}</button>
        )}
      </div>
      {pastePending && !entry.loggedIn && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={styles.hint}>{t("pasteHint")}</div>
          <div style={styles.row}>
            <input
              style={{ ...styles.button, flex: 1, minWidth: 220, cursor: "text" }}
              value={codeText}
              placeholder={t("pastePlaceholder")}
              onChange={(event) => onCodeChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSubmitCode();
              }}
            />
            <button style={styles.button} onClick={onSubmitCode} disabled={codeText.trim().length === 0}>
              {t("submitCode")}
            </button>
          </div>
        </div>
      )}
      {entry.loggedIn && report !== undefined && report.supported && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {report.windows.map((window) => (
            <div key={window.id} style={styles.row}>
              <span style={{ ...styles.hint, minWidth: 130 }}>{window.label}</span>
              <div style={styles.meter}>
                <div style={{ ...styles.meterFill, width: `${Math.round(window.usedPercent ?? 0)}%` }} />
              </div>
              <span style={styles.hint}>
                {window.usedPercent !== undefined ? t("used", { percent: Math.round(window.usedPercent) }) : ""}
                {window.resetsAt !== undefined ? ` · ${formatReset(t, window.resetsAt)}` : ""}
              </span>
            </div>
          ))}
          {report.windows.length === 0 && <div style={styles.hint}>{t("noWindows")}</div>}
        </div>
      )}
    </div>
  );
}
