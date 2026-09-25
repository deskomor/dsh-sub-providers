/* dsh-sub-providers client half — clean-room build. */
window.__ModuleLoader__.load({
	id: "dsh-sub-providers/client",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		"use strict";
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __export = (target, all) => {
		  for (var name in all)
		    __defProp(target, name, { get: all[name], enumerable: true });
		};
		var __copyProps = (to, from, except, desc) => {
		  if (from && typeof from === "object" || typeof from === "function") {
		    for (let key of __getOwnPropNames(from))
		      if (!__hasOwnProp.call(to, key) && key !== except)
		        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
		  }
		  return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
		  // If the importer is in node compatibility mode or this is not an ESM
		  // file that has been converted to a CommonJS file using a Babel-
		  // compatible transform (i.e. "__esModule" has not been set), then set
		  // "default" to the CommonJS "module.exports" for node compatibility.
		  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
		  mod
		));
		var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

		// src/client/index.tsx
		var index_exports = {};
		__export(index_exports, {
		  apply: () => apply,
		  inject: () => inject
		});
		module.exports = __toCommonJS(index_exports);
		var import_react4 = __toESM(require("react"), 1);

		// src/client/locale.ts
		var import_react = __toESM(require("react"), 1);
		var NS = "sub-providers";
		var PROVIDER_NAMES = {
		  claude: "Claude",
		  codex: "ChatGPT (Codex)"
		};
		var en = {
		  nav: "Subscriptions",
		  title: "Subscription providers",
		  subtitle: "Sign in with your Claude or ChatGPT subscription. Tokens stay in ~/.dsh/plugins/sub-providers/auth.json (mode 0600).",
		  loading: "Loading provider state\u2026",
		  pending: "Sign-in pending in the browser\u2026",
		  signedIn: "Signed in",
		  signedInAs: "Signed in as {email}",
		  notSignedIn: "Not signed in",
		  signIn: "Sign in",
		  signOut: "Sign out",
		  cancel: "Cancel",
		  refreshUsage: "Refresh usage",
		  pasteHint: "Authorize in the opened browser tab, then paste the code the final page shows (if it shows code and state together, paste the full CODE#STATE string).",
		  pastePlaceholder: "Paste authorization code",
		  submitCode: "Submit code",
		  noWindows: "No usage windows reported.",
		  used: "{percent}% used",
		  resetSoon: "resets soon",
		  resetMin: "resets in {minutes} min",
		  resetHours: "resets in {hours} h",
		  resetAt: "resets {when}"
		};
		var zh = {
		  nav: "\u8BA2\u9605",
		  title: "\u8BA2\u9605\u670D\u52A1",
		  subtitle: "\u4F7F\u7528\u4F60\u7684 Claude \u6216 ChatGPT \u8BA2\u9605\u767B\u5F55\u3002\u4EE4\u724C\u4EC5\u4FDD\u5B58\u5728 ~/.dsh/plugins/sub-providers/auth.json\uFF08\u6743\u9650 0600\uFF09\u3002",
		  loading: "\u6B63\u5728\u52A0\u8F7D\u670D\u52A1\u72B6\u6001\u2026",
		  pending: "\u6D4F\u89C8\u5668\u4E2D\u6B63\u5728\u8FDB\u884C\u767B\u5F55\u2026",
		  signedIn: "\u5DF2\u767B\u5F55",
		  signedInAs: "\u5DF2\u767B\u5F55\uFF1A{email}",
		  notSignedIn: "\u672A\u767B\u5F55",
		  signIn: "\u767B\u5F55",
		  signOut: "\u9000\u51FA\u767B\u5F55",
		  cancel: "\u53D6\u6D88",
		  refreshUsage: "\u5237\u65B0\u7528\u91CF",
		  pasteHint: "\u5728\u6253\u5F00\u7684\u6D4F\u89C8\u5668\u6807\u7B7E\u9875\u4E2D\u5B8C\u6210\u6388\u6743\uFF0C\u7136\u540E\u7C98\u8D34\u6700\u540E\u9875\u9762\u663E\u793A\u7684\u4EE3\u7801\uFF08\u82E5\u540C\u65F6\u663E\u793A code \u548C state\uFF0C\u8BF7\u5B8C\u6574\u7C98\u8D34 CODE#STATE\uFF09\u3002",
		  pastePlaceholder: "\u7C98\u8D34\u6388\u6743\u7801",
		  submitCode: "\u63D0\u4EA4\u6388\u6743\u7801",
		  noWindows: "\u6682\u65E0\u7528\u91CF\u7A97\u53E3\u3002",
		  used: "\u5DF2\u7528 {percent}%",
		  resetSoon: "\u5373\u5C06\u91CD\u7F6E",
		  resetMin: "{minutes} \u5206\u949F\u540E\u91CD\u7F6E",
		  resetHours: "{hours} \u5C0F\u65F6\u540E\u91CD\u7F6E",
		  resetAt: "{when} \u91CD\u7F6E"
		};
		var DICTIONARIES = { en, zh };
		function useTranslate(locale) {
		  const [version, bump] = import_react.default.useState(0);
		  import_react.default.useEffect(() => locale.subscribe(() => bump((n) => n + 1)), [locale]);
		  return import_react.default.useMemo(() => {
		    const t = locale.bind(NS);
		    return (key, params) => {
		      const value = t(key, params);
		      if (value !== key) return value;
		      const template = en[key];
		      if (template === void 0) return key;
		      return params === void 0 ? template : template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
		    };
		  }, [locale, version]);
		}

		// src/shared/protocol.ts
		var CHANNEL = "/api";
		var ENDPOINTS = {
		  status: "sub-providers.status",
		  login: "sub-providers.login",
		  submitLogin: "sub-providers.submitLogin",
		  cancelLogin: "sub-providers.cancelLogin",
		  logout: "sub-providers.logout",
		  usage: "sub-providers.usage"
		};

		// src/client/rpc.ts
		function unwrap(result) {
		  if (!result.ok) throw new Error(result.error.message || result.error.code);
		  return result.value;
		}
		var SubProvidersClient = class {
		  rpc;
		  constructor(rpc) {
		    this.rpc = rpc;
		  }
		  async status(signal) {
		    return unwrap(await this.rpc.call(CHANNEL, ENDPOINTS.status, {}, signal));
		  }
		  async login(provider, signal) {
		    return unwrap(await this.rpc.call(CHANNEL, ENDPOINTS.login, { provider }, signal));
		  }
		  /** Complete a `code-paste` login with the code the hosted callback page shows. */
		  async submitLogin(provider, code, signal) {
		    unwrap(await this.rpc.call(CHANNEL, ENDPOINTS.submitLogin, { provider, code }, signal));
		  }
		  async cancelLogin(provider, signal) {
		    unwrap(await this.rpc.call(CHANNEL, ENDPOINTS.cancelLogin, { provider }, signal));
		  }
		  async logout(provider, signal) {
		    unwrap(await this.rpc.call(CHANNEL, ENDPOINTS.logout, { provider }, signal));
		  }
		  async usage(provider, force = false, signal) {
		    return unwrap(await this.rpc.call(CHANNEL, ENDPOINTS.usage, { provider, force }, signal));
		  }
		};

		// src/client/SubscriptionsSection.tsx
		var import_react2 = require("react");
		var import_jsx_runtime = require("react/jsx-runtime");
		var styles = {
		  section: { display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 },
		  card: {
		    border: "1px solid var(--border, #d8d8d8)",
		    borderRadius: 10,
		    padding: 16,
		    display: "flex",
		    flexDirection: "column",
		    gap: 10
		  },
		  title: { margin: 0, fontSize: 15, fontWeight: 600 },
		  subtitle: { margin: 0, fontSize: 12, opacity: 0.75 },
		  row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
		  button: { padding: "4px 12px", borderRadius: 6, cursor: "pointer" },
		  hint: { fontSize: 12, opacity: 0.7 },
		  meter: {
		    height: 6,
		    borderRadius: 3,
		    background: "var(--border, #e5e5e5)",
		    overflow: "hidden",
		    flex: 1,
		    minWidth: 120
		  },
		  meterFill: { height: "100%", background: "var(--accent, #4b7bec)" },
		  error: { color: "#c0392b", fontSize: 12 }
		};
		function formatReset(t, resetsAt) {
		  if (resetsAt === void 0) return "";
		  const delta = resetsAt - Date.now();
		  if (delta <= 0) return t("resetSoon");
		  const minutes = Math.round(delta / 6e4);
		  if (minutes < 60) return t("resetMin", { minutes });
		  const hours = Math.round(minutes / 60);
		  if (hours < 48) return t("resetHours", { hours });
		  return t("resetAt", { when: new Date(resetsAt).toLocaleString() });
		}
		function SubscriptionsSection({ client, locale }) {
		  const t = useTranslate(locale);
		  const [status, setStatus] = (0, import_react2.useState)(void 0);
		  const [usage, setUsage] = (0, import_react2.useState)({});
		  const [busy, setBusy] = (0, import_react2.useState)({});
		  const [pastePending, setPastePending] = (0, import_react2.useState)({});
		  const [codeText, setCodeText] = (0, import_react2.useState)("");
		  const [error, setError] = (0, import_react2.useState)(void 0);
		  const mounted = (0, import_react2.useRef)(true);
		  (0, import_react2.useEffect)(() => {
		    mounted.current = true;
		    return () => {
		      mounted.current = false;
		    };
		  }, []);
		  const refresh = (0, import_react2.useCallback)(async () => {
		    try {
		      const next = await client.status();
		      if (mounted.current) setStatus(next);
		    } catch (cause) {
		      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
		    }
		  }, [client]);
		  (0, import_react2.useEffect)(() => {
		    void refresh();
		  }, [refresh]);
		  (0, import_react2.useEffect)(() => {
		    const anyBusy = status?.providers.some((entry) => entry.busy === true) ?? false;
		    if (!anyBusy) return;
		    const timer = setInterval(() => void refresh(), 1500);
		    return () => clearInterval(timer);
		  }, [status, refresh]);
		  const onLogin = (0, import_react2.useCallback)(
		    async (provider) => {
		      setBusy((state) => ({ ...state, [provider]: true }));
		      setError(void 0);
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
		    [client, refresh]
		  );
		  const onSubmitCode = (0, import_react2.useCallback)(
		    async (provider) => {
		      setError(void 0);
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
		    [client, codeText, refresh]
		  );
		  const onCancel = (0, import_react2.useCallback)(
		    async (provider) => {
		      try {
		        await client.cancelLogin(provider);
		        if (mounted.current) setPastePending((state) => ({ ...state, [provider]: false }));
		        await refresh();
		      } catch (cause) {
		        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
		      }
		    },
		    [client, refresh]
		  );
		  const onLogout = (0, import_react2.useCallback)(
		    async (provider) => {
		      try {
		        await client.logout(provider);
		        setUsage((state) => ({ ...state, [provider]: void 0 }));
		        if (mounted.current) setPastePending((state) => ({ ...state, [provider]: false }));
		        await refresh();
		      } catch (cause) {
		        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
		      }
		    },
		    [client, refresh]
		  );
		  const onUsage = (0, import_react2.useCallback)(
		    async (provider, force = true) => {
		      try {
		        const report = await client.usage(provider, force);
		        if (mounted.current) setUsage((state) => ({ ...state, [provider]: report }));
		      } catch (cause) {
		        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
		      }
		    },
		    [client]
		  );
		  const entries = status?.providers ?? [];
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.section, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: styles.title, children: t("title") }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.subtitle, children: t("subtitle") })
		    ] }),
		    error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.error, children: error }),
		    entries.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.hint, children: t("loading") }),
		    entries.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		      ProviderCard,
		      {
		        t,
		        entry,
		        report: usage[entry.provider],
		        working: busy[entry.provider] === true,
		        pastePending: pastePending[entry.provider] === true,
		        codeText,
		        onCodeChange: setCodeText,
		        onSubmitCode: () => void onSubmitCode(entry.provider),
		        onLogin: () => void onLogin(entry.provider),
		        onCancel: () => void onCancel(entry.provider),
		        onLogout: () => void onLogout(entry.provider),
		        onUsage: () => void onUsage(entry.provider)
		      },
		      entry.provider
		    ))
		  ] });
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
		  onUsage
		}) {
		  const name = PROVIDER_NAMES[entry.provider] ?? entry.provider;
		  const stateText = entry.busy === true ? t("pending") : entry.loggedIn ? `${entry.email !== void 0 ? t("signedInAs", { email: entry.email }) : t("signedIn")}${entry.plan !== void 0 ? ` \xB7 ${entry.plan}` : ""}` : t("notSignedIn");
		  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.card, children: [
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.row, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { style: styles.title, children: name }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.hint, children: stateText })
		    ] }),
		    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.row, children: [
		      entry.loggedIn ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: styles.button, onClick: onLogout, children: t("signOut") }) : entry.busy === true || pastePending ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: styles.button, onClick: onCancel, children: t("cancel") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: styles.button, onClick: onLogin, disabled: working, children: t("signIn") }),
		      entry.loggedIn && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: styles.button, onClick: onUsage, children: t("refreshUsage") })
		    ] }),
		    pastePending && !entry.loggedIn && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 8 }, children: [
		      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.hint, children: t("pasteHint") }),
		      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.row, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
		          "input",
		          {
		            style: { ...styles.button, flex: 1, minWidth: 220, cursor: "text" },
		            value: codeText,
		            placeholder: t("pastePlaceholder"),
		            onChange: (event) => onCodeChange(event.target.value),
		            onKeyDown: (event) => {
		              if (event.key === "Enter") onSubmitCode();
		            }
		          }
		        ),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: styles.button, onClick: onSubmitCode, disabled: codeText.trim().length === 0, children: t("submitCode") })
		      ] })
		    ] }),
		    entry.loggedIn && report !== void 0 && report.supported && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 8 }, children: [
		      report.windows.map((window2) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.row, children: [
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...styles.hint, minWidth: 130 }, children: window2.label }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.meter, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...styles.meterFill, width: `${Math.round(window2.usedPercent ?? 0)}%` } }) }),
		        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: styles.hint, children: [
		          window2.usedPercent !== void 0 ? t("used", { percent: Math.round(window2.usedPercent) }) : "",
		          window2.resetsAt !== void 0 ? ` \xB7 ${formatReset(t, window2.resetsAt)}` : ""
		        ] })
		      ] }, window2.id)),
		      report.windows.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.hint, children: t("noWindows") })
		    ] })
		  ] });
		}

		// src/client/UsagePill.tsx
		var import_react3 = require("react");
		var import_jsx_runtime2 = require("react/jsx-runtime");
		var styles2 = {
		  root: {
		    display: "inline-flex",
		    gap: 6,
		    alignItems: "center"
		  },
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
		    background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06))"
		  }
		};
		var REFRESH_MS = 5 * 6e4;
		function UsagePill({ client, locale }) {
		  const t = useTranslate(locale);
		  const [items, setItems] = (0, import_react3.useState)([]);
		  (0, import_react3.useEffect)(() => {
		    let alive = true;
		    const load = async () => {
		      try {
		        const status = await client.status();
		        const loggedIn = status.providers.filter((entry) => entry.loggedIn);
		        const reports = await Promise.all(
		          loggedIn.map(async (entry) => {
		            try {
		              return await client.usage(entry.provider);
		            } catch {
		              return void 0;
		            }
		          })
		        );
		        if (!alive) return;
		        const next = [];
		        for (const report of reports) {
		          if (report === void 0 || !report.supported) continue;
		          const item = toPillItem(report, t);
		          if (item !== void 0) next.push(item);
		        }
		        setItems(next);
		      } catch {
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
		  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: styles2.root, children: items.map((item) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: styles2.pill, title: item.tooltip, children: [
		    item.name,
		    " ",
		    item.percent,
		    "%"
		  ] }, item.provider)) });
		}
		function toPillItem(report, t) {
		  const withPercent = report.windows.filter((window2) => typeof window2.usedPercent === "number");
		  if (withPercent.length === 0) return void 0;
		  const percent = Math.round(Math.max(...withPercent.map((window2) => window2.usedPercent)));
		  const tooltip = report.windows.map((window2) => {
		    const parts = [`${window2.label}: ${Math.round(window2.usedPercent ?? 0)}%`];
		    if (window2.resetsAt !== void 0) parts.push(new Date(window2.resetsAt).toLocaleString());
		    return parts.join(" \xB7 ");
		  }).join("\n");
		  return {
		    provider: report.provider,
		    name: PROVIDER_NAMES[report.provider] ?? report.provider,
		    percent,
		    tooltip: tooltip.length > 0 ? tooltip : t("title")
		  };
		}

		// src/client/index.tsx
		var inject = ["connection", "locale", "slots"];
		function safe(step, run) {
		  try {
		    run();
		  } catch (cause) {
		    console.error(`dsh-sub-providers: ${step} failed`, cause);
		  }
		}
		function apply(ctx) {
		  const { connection, slots, locale } = ctx;
		  const client = new SubProvidersClient(connection.rpc);
		  const navLabel = () => {
		    const value = locale.bind(NS)("nav");
		    return value === "nav" ? "Subscriptions" : value;
		  };
		  safe("dictionary registration", () => {
		    ctx.effect(() => locale.register(NS, DICTIONARIES), "dsh-sub-providers: dictionaries");
		  });
		  safe("settings section registration", () => {
		    slots.inject(
		      "settings.section",
		      () => slots.register(
		        {
		          name: "settings.section",
		          id: "sub-providers",
		          order: 60,
		          label: navLabel
		        },
		        () => import_react4.default.createElement(SubscriptionsSection, { client, locale })
		      )
		    );
		  });
		  safe("usage pill registration", () => {
		    slots.inject(
		      "conversation.input.right",
		      () => slots.register(
		        {
		          name: "conversation.input.right",
		          id: "sub-providers-usage",
		          order: 60
		        },
		        () => import_react4.default.createElement(UsagePill, { client, locale })
		      )
		    );
		  });
		}

		return module.exports;
	}
});
