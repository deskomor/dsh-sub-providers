/**
 * Locale dictionaries (en/zh) and the translate helper shared by the client
 * components. Parameter interpolation uses the harness `{param}` convention.
 */
import React from "react";

export const NS = "sub-providers";

/** Proper nouns stay Latin in every locale. */
export const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "ChatGPT (Codex)",
};

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface LocaleApi {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void;
  bind(ns: string): Translate;
  subscribe(fn: () => void): () => void;
}

const en = {
  nav: "Subscriptions",
  title: "Subscription providers",
  subtitle:
    "Sign in with your Claude or ChatGPT subscription. Tokens stay in ~/.dsh/plugins/sub-providers/auth.json (mode 0600).",
  loading: "Loading provider state…",
  pending: "Sign-in pending in the browser…",
  signedIn: "Signed in",
  signedInAs: "Signed in as {email}",
  notSignedIn: "Not signed in",
  signIn: "Sign in",
  signOut: "Sign out",
  cancel: "Cancel",
  refreshUsage: "Refresh usage",
  pasteHint:
    "Authorize in the opened browser tab, then paste the code the final page shows (if it shows code and state together, paste the full CODE#STATE string).",
  pastePlaceholder: "Paste authorization code",
  submitCode: "Submit code",
  noWindows: "No usage windows reported.",
  used: "{percent}% used",
  resetSoon: "resets soon",
  resetMin: "resets in {minutes} min",
  resetHours: "resets in {hours} h",
  resetAt: "resets {when}",
};

const zh: Record<keyof typeof en, string> = {
  nav: "订阅",
  title: "订阅服务",
  subtitle:
    "使用你的 Claude 或 ChatGPT 订阅登录。令牌仅保存在 ~/.dsh/plugins/sub-providers/auth.json（权限 0600）。",
  loading: "正在加载服务状态…",
  pending: "浏览器中正在进行登录…",
  signedIn: "已登录",
  signedInAs: "已登录：{email}",
  notSignedIn: "未登录",
  signIn: "登录",
  signOut: "退出登录",
  cancel: "取消",
  refreshUsage: "刷新用量",
  pasteHint:
    "在打开的浏览器标签页中完成授权，然后粘贴最后页面显示的代码（若同时显示 code 和 state，请完整粘贴 CODE#STATE）。",
  pastePlaceholder: "粘贴授权码",
  submitCode: "提交授权码",
  noWindows: "暂无用量窗口。",
  used: "已用 {percent}%",
  resetSoon: "即将重置",
  resetMin: "{minutes} 分钟后重置",
  resetHours: "{hours} 小时后重置",
  resetAt: "{when} 重置",
};

/** Dictionaries for {@link NS}, keyed by locale id. */
export const DICTIONARIES: Record<string, Record<string, string>> = { en, zh };

/** Translate hook that re-renders the component when the locale changes. */
export function useTranslate(locale: LocaleApi): Translate {
  const [version, bump] = React.useState(0);
  React.useEffect(() => locale.subscribe(() => bump((n) => n + 1)), [locale]);
  // Stable across unrelated renders (safe as a hook dependency), recreated on
  // locale change so a snapshot-capturing bind() always sees fresh strings.
  return React.useMemo(() => locale.bind(NS), [locale, version]);
}
